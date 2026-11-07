// Scrollytelling donor map for map.html. d3 and topojson are globals from the CDN scripts in map.html.
// The data lives in src/data/map/ so Parcel does not have to parse it as part of the page.

// Built from Campaign Funding - chevalier top donors.csv. Each ZIP is [lon, lat] at a point inside its area in
// cb_2020_us_zcta520_500k. Each donor is [zip, amount, in New York]. ZIPs with no area of their own sit at the closest
// ZIP listed in `nearby`.
import DATA from '../data/map/donors.json';
// Districts from cb_2025_us_cd119_500k, simplified: the lower 48 and DC, plus the Virgin Islands for the inset.
// These are .topojson rather than .json so Parcel copies them as they are and hands back their URL, instead of turning
// them into JavaScript and running Babel over them on every build. They are fetched before the map draws.
import districtsUrl from '../data/map/districts.topojson';
import islandsUrl from '../data/map/islands.topojson';
// The same districts unsimplified, clipped to the areas around the two close-ups and swapped in when zoomed in.
import detailNyUrl from '../data/map/detail-ny.topojson';
import detailSfUrl from '../data/map/detail-sf.topojson';

const fetchJson = url => fetch(url).then(response => {
  if (!response.ok) throw new Error(`${response.status} loading ${url}`);
  return response.json();
});

Promise.all([districtsUrl, islandsUrl, detailNyUrl, detailSfUrl].map(fetchJson))
  .then(([DISTRICTS, ISLANDS, DETAIL_NY, DETAIL_SF]) => drawMap(DISTRICTS, ISLANDS, DETAIL_NY, DETAIL_SF))
  .catch(error => console.error("Could not load the donor map:", error));

function drawMap(DISTRICTS, ISLANDS, DETAIL_NY, DETAIL_SF) {
  // One entry per .step, in order.
  const STEPS = [
    { view: "nyc", dots: false, district: true },
    { view: "nyc", dots: true, district: true },
    { view: "country", dots: true, district: false },
    { view: "sf", dots: true, district: false, spotlight: d => d.zip === "94117" && d.amount === 7000 },
    { view: "sf", dots: true, district: false, spotlight: d => d.zip === "94117" && d.amount === 7000 },
    { view: "country", dots: true, district: false }
  ];
  // [[west, south], [east, north]] of each close-up.
  const VIEWS = {
    nyc: [[-74.26, 40.49], [-73.7, 40.92]],
    sf: [[-122.57, 37.665], [-122.3, 37.855]]
  };
  // Matches the CSS breakpoint where the cards move into a rail beside the map.
  const WIDE = window.matchMedia("(min-width: 900px)");
  const TRANSITION_MS =window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1500;

  const donors = DATA.donors.map(([zip, amount, inNewYork]) => ({ zip, amount, inNewYork }));

  // Radius is directly proportional to the amount, and anything under MIN_AMOUNT is drawn at MIN_AMOUNT's size.
  const MAX_RADIUS = 28;
  const MIN_AMOUNT = 500;
  const radiusPerDollar = MAX_RADIUS / d3.max(donors, d => d.amount);
  const radius = amount => Math.max(MIN_AMOUNT, amount) * radiusPerDollar;

  const money = d3.format("$,.0f");

  const districtObject = DISTRICTS.objects.districts;
  const land = topojson.feature(DISTRICTS, districtObject);
  // Lines between districts in the same state are lighter than state borders and coastlines.
  const sameState = (a, b) => a !== b && a.properties.STATEFP === b.properties.STATEFP;
  const otherState = (a, b) => a === b || a.properties.STATEFP !== b.properties.STATEFP;
  const districtLines = topojson.mesh(DISTRICTS, districtObject, sameState);
  const stateLines = topojson.mesh(DISTRICTS, districtObject, otherState);

  const islands = topojson.feature(ISLANDS, ISLANDS.objects.islands);
  const islandLines = topojson.mesh(ISLANDS, ISLANDS.objects.islands);
  const inIslands = ([lon, lat]) => lon > -66 && lat < 19;

  // A detail region is only shown while the whole screen is inside its clip box, so the clipped edges never show.
  const regions = [
    { topo: DETAIL_NY, box: [-80, 38, -68, 45.5] },
    { topo: DETAIL_SF, box: [-125.5, 34, -116, 42.5] }
  ].map(({ topo, box }) => {
    const object = topo.objects.districts;
    return {
      box,
      land: topojson.feature(topo, object),
      districtLines: topojson.mesh(topo, object, sameState),
      stateLines: topojson.mesh(topo, object, otherState)
    };
  });
  const ny13 = regions[0].land.features.find(f => f.properties.STATEFP === "36" && f.properties.CD119FP === "13");

  const zipGroups = d3.rollups(donors, v => ({
    donors: v.length,
    total: d3.sum(v, d => d.amount),
    largest: d3.max(v, d => d.amount)
  }), d => d.zip).map(([zip, summary]) => ({ zip, ...summary, lonLat: DATA.zips[zip] }));

  const tooltip = d3.select("#tooltip");
  const legend = d3.select("#legend");
  const note = d3.select(".map-embed .note");
  const map = d3.select("#map");
  const svg = map.append("svg")
    .attr("role", "img")
    .attr("aria-label", `Congressional district map of the lower 48 states and DC, with an inset of the US Virgin Islands and one dot for each of ${donors.length} individual donors, placed at their ZIP code and sized by amount. Orange dots are in New York State and purple dots are outside it.`);
  const geoLayer = svg.append("g");
  const coarseLayer = geoLayer.append("g");
  const landLayer = coarseLayer.append("g").attr("class", "land");
  const districtLayer = coarseLayer.append("g").attr("class", "districts");
  const stateLayer = coarseLayer.append("g").attr("class", "states");
  for (const region of regions) {
    region.layer = geoLayer.append("g").style("display", "none");
    region.landPath = region.layer.append("g").attr("class", "land").append("path");
    region.districtPath = region.layer.append("g").attr("class", "districts").append("path");
    region.statePath = region.layer.append("g").attr("class", "states").append("path");
  }
  const highlightLayer = geoLayer.append("g").attr("class", "highlight");
  const insetLayer = geoLayer.append("g");
  const insetLabel = svg.append("text").attr("class", "inset-label").text("U.S. Virgin Islands");
  const markLayer = svg.append("g").attr("class", "marks");

  function drawLegend(sizeFactor) {
    legend.html("");

    const colors = legend.append("div").attr("class", "legend-group").selectAll("div")
      .data([
        { key: "outside", label: "Outside New York State" },
        { key: "new-york", label: "New York State" }
      ])
      .join("div")
      .attr("class", d => `legend-color ${d.key}`);
    colors.append("span").attr("class", "dot");
    colors.append("span").text(d => d.label);

    // Nested circles share a baseline, and a straight line runs from the top of each circle to its label.
    const sizes = [
      { amount: 10000, label: "$10K" },
      { amount: 5000, label: "$5K" },
      { amount: 1000, label: "$1K" }
    ].map(d => ({ ...d, r: radius(d.amount) * sizeFactor }));
    const maxR = sizes[0].r;
    const baseline = maxR * 2 + 8;
    const labelX = maxR * 2 + 12;

    const key = legend.append("svg")
      .attr("class", "legend-size")
      .attr("role", "img")
      .attr("aria-label", `Dot sizes by donation amount: ${sizes.map(d => d.label).join(", ")}`)
      .attr("width", labelX + 40)
      .attr("height", baseline + 2)
      .selectAll("g")
      .data(sizes)
      .join("g");
    key.append("circle")
      .attr("cx", maxR)
      .attr("cy", d => baseline - d.r)
      .attr("r", d => d.r);
    key.append("line")
      .attr("x1", maxR)
      .attr("x2", labelX - 4)
      .attr("y1", d => baseline - d.r * 2)
      .attr("y2", d => baseline - d.r * 2);
    key.append("text")
      .attr("x", labelX)
      .attr("y", d => baseline - d.r * 2)
      .attr("dy", "0.32em")
      .text(d => d.label);
  }

  function moveTooltip(event) {
    const node = tooltip.node();
    const { width, height } = node.getBoundingClientRect();
    const x = Math.min(event.clientX + 14, window.innerWidth - width - 8);
    const y = Math.max(event.clientY - height - 12, 8);
    tooltip.style("left", `${Math.max(x, 8)}px`).style("top", `${y}px`);
  }

  function showTooltip(event, d) {
    tooltip.html("").style("visibility", "visible");
    tooltip.append("strong").text(`ZIP Code: ${d.zip}`);
    tooltip.append("span").text(`${money(d.total)} from ${d.donors} ${d.donors === 1 ? "donor" : "donors"}`);
    if (d.donors > 1) tooltip.append("span").text(`Largest donor: ${money(d.largest)}`);
    if (DATA.nearby[d.zip]) tooltip.append("span").text(`Placed at nearby ZIP ${DATA.nearby[d.zip]}`);
    moveTooltip(event);
  }

  let step = 0;
  let scene = null;

  function showStep(animate) {
    const s = STEPS[step];
    legend.classed("hidden", !s.dots);
    note.classed("hidden", !s.dots);
    markLayer.classed("hidden", !s.dots);
    highlightLayer.classed("hidden", !s.district);
    if (!scene) return;
    scene.marks.classed("spotlight", d => Boolean(s.spotlight && s.spotlight(d)));
    scene.marks.filter(".spotlight").raise();
    if (!s.dots) {
      scene.marks.classed("active", false);
      tooltip.style("visibility", "hidden");
    }
    const target = scene.viewTransform(s.view);
    if (animate && TRANSITION_MS) svg.transition().duration(TRANSITION_MS).call(scene.zoom.transform, target);
    else svg.interrupt().call(scene.zoom.transform, target);
  }

  function draw(width, height) {
    // On wide screens the cards sit in a rail on the left, and the map fits to the right of it, below the legend.
    const wide = WIDE.matches;
    const rail = wide ? 424 : 16;
    const sizeFactor = Math.max(0.65, Math.min(1, (width - rail - 16) / 900));
    drawLegend(sizeFactor);
    legend.style("left", `${rail}px`);
    note.style("left", `${rail}px`);
    const top = 16 + legend.node().offsetHeight + 12;
    const bottom = height - 12 - note.node().offsetHeight - 12;
    // On phones and tablets the cards cover the lower part of the screen, so the map fits into the upper part.
    const area = [[rail, top], [width - 16, wide ? bottom : top + (bottom - top) * 0.55]];

    // The Virgin Islands sit in their own inset at the bottom right, on their own scale.
    const insetWidth = Math.max(84, (area[1][0] - area[0][0]) * 0.13);
    const insetHeight = insetWidth * 0.62;
    // On phones and tablets the inset is too big to tuck beside Florida, so the lower 48 fit above a strip held for it,
    // with room in between for the inset's label.
    const INSET_GAP = 18;
    const fitArea = wide ? area : [area[0], [area[1][0], area[1][1] - insetHeight - INSET_GAP]];

    const projection = d3.geoAlbers()
      .rotate([96, 0])
      .center([-0.6, 38.7])
      .parallels([29.5, 45.5])
      .fitExtent(fitArea, land);
    const path = d3.geoPath(projection);

    const landBottom = path.bounds(land)[1][1];
    const inset = {
      x: area[1][0] - insetWidth,
      y: wide ? area[1][1] - insetHeight : Math.min(landBottom + INSET_GAP, area[1][1] - insetHeight)
    };
    const islandProjection = d3.geoMercator().fitExtent(
      [[inset.x + 6, inset.y + 6], [inset.x + insetWidth - 6, inset.y + insetHeight - 6]],
      islands
    );
    const islandPath = d3.geoPath(islandProjection);
    const pathFor = d => (d === islands || d === islandLines ? islandPath : path)(d);
    const project = lonLat => (inIslands(lonLat) ? islandProjection : projection)(lonLat);

    svg.attr("viewBox", `0 0 ${width} ${height}`);
    landLayer.selectAll("path").data([land, islands]).join("path").attr("d", pathFor);
    districtLayer.selectAll("path").data([districtLines]).join("path").attr("d", path);
    stateLayer.selectAll("path").data([stateLines, islandLines]).join("path").attr("d", pathFor);
    for (const region of regions) {
      region.landPath.attr("d", path(region.land));
      region.districtPath.attr("d", path(region.districtLines));
      region.statePath.attr("d", path(region.stateLines));
      // The clip box's outline on screen, traced along each edge because its sides curve in this projection.
      const [w, s, e, n] = region.box;
      const edge = (from, to) => d3.range(20).map(i => [from[0] + (to[0] - from[0]) * i / 20, from[1] + (to[1] - from[1]) * i / 20]);
      region.outline = [...edge([w, s], [e, s]), ...edge([e, s], [e, n]), ...edge([e, n], [w, n]), ...edge([w, n], [w, s])].map(projection);
    }
    highlightLayer.selectAll("path").data([ny13]).join("path").attr("d", path);
    insetLayer.selectAll("rect").data([inset]).join("rect")
      .attr("class", "inset-frame")
      .attr("x", inset.x)
      .attr("y", inset.y)
      .attr("width", insetWidth)
      .attr("height", insetHeight);

    const placedZips = zipGroups
      .map(d => ({ ...d, point: project(d.lonLat) }))
      .filter(d => d.point);
    const pointByZip = new Map(placedZips.map(d => [d.zip, d.point]));

    // Bigger dots go first so smaller ones stay visible on top.
    const dots = donors
      .filter(d => pointByZip.has(d.zip))
      .map(d => ({ ...d, point: pointByZip.get(d.zip), r: radius(d.amount) * sizeFactor }));

    const marks = markLayer.selectAll("circle")
      .data(d3.sort(dots, d => -d.r))
      .join("circle")
      .attr("class", d => `mark ${d.inNewYork ? "new-york" : "outside"}`)
      .attr("r", d => d.r);

    let current = d3.zoomIdentity;
    function applyZoom(t) {
      current = t;
      geoLayer.attr("transform", t);
      insetLabel
        .attr("x", t.applyX(inset.x + insetWidth / 2))
        .attr("y", t.applyY(inset.y) - 5);
      marks.attr("cx", d => t.applyX(d.point[0])).attr("cy", d => t.applyY(d.point[1]));
      const corners = [[0, 0], [width, 0], [width, height], [0, height]].map(p => t.invert(p));
      let detailed = false;
      for (const region of regions) {
        const shown = corners.every(p => d3.polygonContains(region.outline, p));
        region.layer.style("display", shown ? null : "none");
        detailed = detailed || shown;
      }
      coarseLayer.style("display", detailed ? "none" : null);
    }

    // The zoom only follows the steps. Wheel and drag are left to the page so scrolling always moves the story.
    const zoom = d3.zoom()
      .extent([[0, 0], [width, height]])
      .on("zoom", event => applyZoom(event.transform));

    function viewTransform(view) {
      if (view === "country") return d3.zoomIdentity;
      const [[w, s], [e, n]] = VIEWS[view];
      const corners = [[w, s], [e, s], [e, n], [w, n]].map(projection);
      const [x0, x1] = d3.extent(corners, p => p[0]);
      const [y0, y1] = d3.extent(corners, p => p[1]);
      const k = 0.85 * Math.min((area[1][0] - area[0][0]) / (x1 - x0), (area[1][1] - area[0][1]) / (y1 - y0));
      const cx = (area[0][0] + area[1][0]) / 2;
      const cy = (area[0][1] + area[1][1]) / 2;
      return d3.zoomIdentity.translate(cx - k * (x0 + x1) / 2, cy - k * (y0 + y1) / 2).scale(k);
    }

    // Hover snaps to the nearest ZIP, because many of the dots are too small to aim at.
    const HIT_RADIUS = 24;
    const delaunay = d3.Delaunay.from(placedZips, d => d.point[0], d => d.point[1]);
    function setActive(zip) {
      marks.classed("active", m => m.zip === zip);
    }
    // On touch screens a tap shows the tooltip, which stays until another tap or a scroll.
    svg.on("pointermove pointerdown", event => {
      if (!STEPS[step].dots) return;
      const [px, py] = d3.pointer(event, svg.node());
      const [x, y] = current.invert([px, py]);
      const nearest = placedZips[delaunay.find(x, y)];
      const distance = Math.hypot(nearest.point[0] - x, nearest.point[1] - y) * current.k;
      if (distance > HIT_RADIUS) {
        setActive(null);
        tooltip.style("visibility", "hidden");
        return;
      }
      setActive(nearest.zip);
      showTooltip(event, nearest);
    });
    svg.on("pointerleave", event => {
      if (event.pointerType !== "mouse") return;
      setActive(null);
      tooltip.style("visibility", "hidden");
    });

    scene = { marks, zoom, viewTransform, setActive };
    showStep(false);
  }

  let drawnSize = "";
  new ResizeObserver(([entry]) => {
    const width = Math.round(entry.contentRect.width);
    const height = Math.round(entry.contentRect.height);
    if (width && height && `${width}x${height}` !== drawnSize) {
      drawnSize = `${width}x${height}`;
      draw(width, height);
    }
  }).observe(map.node());

  // On wide screens a step takes over once the top of its card passes 65% of the way down the screen. On phones and
  // tablets the cards stop low, so a step takes over once its whole card has scrolled into view above the note.
  const cards = [...document.querySelectorAll(".map-embed .step .card")];
  function isShown(card) {
    const { top, bottom } = card.getBoundingClientRect();
    return WIDE.matches ? top < window.innerHeight * 0.65 : bottom < window.innerHeight - 40;
  }
  function onScroll() {
    if (scene) scene.setActive(null);
    tooltip.style("visibility", "hidden");
    let next = 0;
    cards.forEach((card, i) => {
      if (isShown(card)) next = i;
    });
    if (next !== step) {
      step = next;
      showStep(true);
    }
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  // Crossing the breakpoint moves the cards without resizing the map, so redraw for the new layout.
  WIDE.addEventListener("change", () => {
    if (drawnSize) draw(...drawnSize.split("x").map(Number));
  });
  showStep(false);
  onScroll();
}
