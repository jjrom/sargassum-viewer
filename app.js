/**
 * Sargassum Viewer
 * 
 * @copyright Jérôme Gasperi
 */
/** ========================== Configuration ================================ **/

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'; // Grey map
//const MAP_STYLE = 'data/dark-matter-style.json';

const EEZ_WMS_URL = 'https://geo.vliz.be/geoserver/MarineRegions/wms';

const API_FORECAST_ENDPOINT = 'http://localhost:4443/forecast/'; // Base URL for GeoJSON files
//const API_FORECAST_ENDPOINT = 'https://sargassum-backend.lab.dive.edito.eu/forecast/';

// Play animation configuration
const PICK_DELAY = 1000; // Limit to 1 call per second
const ANIMATION_DELAY = 1000; // 1 second delay
const ANIMATION_DAY_OFFSET = 1;

let sargassumThresholdValue = 80;

// Map configuration
const INITIAL_VIEW_STATE = {
    latitude: 20,
    longitude: -43,
    zoom: 3,
    pitch: 0,
    bearing: 0,
    maxBounds: [
        [-111.445312, -14.264383],
        [27.773438, 61.270233]
    ],
    EEZ: 'French Exclusive Economic Zone (Guadeloupe)'
};

/** ========================== Computed variables ================================ **/
const navigatorLanguage = () => (navigator.languages && navigator.languages.length) ? navigator.languages[0] : navigator.userLanguage || navigator.language || navigator.browserLanguage || 'en';

// Cancel fetch promise
let abortController = {
    currentForecast: new AbortController(),
    previousForecast: new AbortController()
};

let firstTimeEEZ = true;
let hoveredStateId = null;
let clickedStateId = null;
let showPreviousForecast = false;

const startDate = new Date(Date.parse((new Date()).toISOString().split('T')[0] + 'T12:00:00Z'));
const endDate = new Date();
endDate.setMonth(startDate.getMonth() + 7); // 7 months into the future
endDate.setDate(1);

const totalDays = Math.round((endDate - startDate) / (1000 * 60 * 60 * 24)); // Difference in days
let currentDate = new Date(startDate); // Default to start date

let currentEEZ = null;

let forecastUrl = API_FORECAST_ENDPOINT + formatDateISO(currentDate);
const volumeUrl = forecastUrl + '/volume/';
let isPlaying = false; // Animation state
let isFetching = false; // Prevent overlapping requests

/** ========================== [UI] Date Slider ================================ **/
const dateSlider = document.getElementById('date-slider');
const startLabel = document.getElementById("start-label");
const endLabel = document.getElementById("end-label");
const dateLabel = document.getElementById('date-label');
const playPauseBtn = document.getElementById('play-pause-btn');
const eezArea = document.getElementById('eez-area');
const maximumValue = document.getElementById('maximum-value');
const chartContainer = document.getElementById('chart-container');
const loadingSpinner = document.getElementById('loading-spinner');
const fetchingSpinner = document.getElementById('fetching-spinner');
const coveringPeriod = document.getElementById('covering-period');
const visualMeasure = document.getElementById('visual-measure');

// Set slider min/max values
dateSlider.min = 0;
dateSlider.max = Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24));
dateSlider.value = 0;

// Event listener for manual date change
dateSlider.addEventListener('input', (event) => {
    isPlaying = false;
    playPauseBtn.querySelector('i').classList.replace('fa-pause', 'fa-play');
    updateDate(parseInt(event.target.value, 10), false);
});

// Event listener for manual date change
dateSlider.addEventListener('change', (event) => {
    updateDate(parseInt(event.target.value, 10), true);
});

// Play/Pause Animation
playPauseBtn.addEventListener('click', async () => {
    isPlaying = !isPlaying;
    let icon = playPauseBtn.querySelector('i');
    isPlaying ? icon.classList.replace('fa-play', 'fa-pause') : icon.classList.replace('fa-pause', 'fa-play');
    while (isPlaying && parseInt(dateSlider.value, 10) < totalDays) {
        await updateDate(parseInt(dateSlider.value, 10) + ANIMATION_DAY_OFFSET, true);
        if (parseInt(dateSlider.value, 10) >= totalDays) {
            isPlaying = false;
            playPauseBtn.querySelector('i').classList.replace('fa-pause', 'fa-play');
        }
        await new Promise(resolve => setTimeout(resolve, ANIMATION_DELAY));
    }
});

/** ========================== [UI] Toggles ============================================== **/
const previousForecastCheckBox = document.getElementById('previous-forecast-checkbox');
previousForecastCheckBox.addEventListener("change", function () {
    if (this.checked) {
        if (chartData && chartData.length > 0) {
            getPreviousForecast();
        }
        showPreviousForecast = true;  
    } else {
        if (abortController.previousForecast) {
            abortController.previousForecast.abort(); 
        }
        if (timeChart) {
            for (var i = 0, ii = timeChart.data.datasets.length; i < ii; i++) {
                if (timeChart.data.datasets[i].id === 'previousForecast') {
                    timeChart.data.datasets.splice(i, 1);
                    updateChart();
                    break;
                }
            }
        }
        
        showPreviousForecast = false;
    }
});

/** ========================== [UI] Fullscreen ================================= */
/*document.addEventListener("DOMContentLoaded", function () {
    const fullscreenBtn = document.getElementById("fullscreenBtn");

    fullscreenBtn.addEventListener("click", function () {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen();
            fullscreenBtn.textContent = "Exit Fullscreen";
        } else {
            document.exitFullscreen();
            fullscreenBtn.textContent = "Fullscreen";
        }
    });
});*/
/** ========================== [UI] Location    ================================ */
const locationSelect = document.getElementById("locationSelect");

locationSelect.addEventListener("change", function () {
    selectEEZ(this.value);
});

/** ========================== [UI] Full width chart  ================================ */
const toggleLeftZoneBtn = document.getElementById("toggle-left-zone");
const leftZone = document.getElementById("left-zone");
const rightZone = document.getElementById("right-zone");
let isLeftZoneVisible = true; // Track state

toggleLeftZoneBtn.addEventListener("click", function () {
    if (isLeftZoneVisible) {
        leftZone.classList.add("hidden-left-zone"); // Hide left zone
        rightZone.classList.add("full-width"); // Expand right zone
        toggleLeftZoneBtn.textContent = "Show statistics";
    } else {
        leftZone.classList.remove("hidden-left-zone"); // Show left zone
        rightZone.classList.remove("full-width"); // Restore right zone size
        toggleLeftZoneBtn.textContent = "Hide statistics";
    }
    isLeftZoneVisible = !isLeftZoneVisible; // Toggle state
});

/** ========================== [UI] Map ================================ **/
// Sargassum heatmap parameters
let sargassum = {
    data: {
        type: 'FeatureCollection',
        features: []
    }
};

let currentFeatureCoordinates = undefined;
let map = null;

const popup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false
});

(async () => {

    // Get the style then entend it with the globe projection
    const style = await fetch(MAP_STYLE)
        .then((response) => response.json())
        .then((style) => {
            /*return {
                ...style,
                projection: {
                    type: "globe",
                },
            };*/
            return style;
        });

    // Initialize MapLibre
    map = new maplibregl.Map({
        container: 'map',
        style: style,
        center: [INITIAL_VIEW_STATE.longitude, INITIAL_VIEW_STATE.latitude],
        zoom: INITIAL_VIEW_STATE.zoom,
        pitch: INITIAL_VIEW_STATE.pitch,
        bearing: INITIAL_VIEW_STATE.bearing,
        cooperativeGestures: true,
        maxBounds: INITIAL_VIEW_STATE.maxBounds // Sets bounds as max
    });

    // Click on EEZ centroid trigger change on Select location
    map.on('click', 'eez-layer', (e) => {
        locationSelect.value = e.features[0].properties.GEONAME;
        locationSelect.dispatchEvent(new Event("change"));
    });

    // Change cursor when hovering over points
    map.on('mousemove', 'eez-layer', (e) => {

        const lngLat = e.lngLat;
        popup.setLngLat(lngLat).setHTML(`<h3><b>${e.features[0].properties.GEONAME}</h3>`).addTo(map);

        if (hoveredStateId) {
            map.setFeatureState(
                {source: 'eez-source', id: hoveredStateId},
                {hover: false}
            );
        }
        hoveredStateId = e.features[0].id;
        map.setFeatureState(
            {source: 'eez-source', id: hoveredStateId},
            {hover: true}
        );
    });

    // Hide tooltip when mouse leaves the map
    map.on('mouseleave', 'eez-layer', (e) => {
        currentFeatureCoordinates = undefined;
        if (hoveredStateId) {
            map.setFeatureState(
                {source: 'eez-source', id: hoveredStateId},
                {hover: false}
            );
        }
        hoveredStateId = null;
        map.getCanvas().style.cursor = '';
        popup.remove();
    });

    // Population locationSelect whith EEZ GeoJSON Feature
    map.on('sourcedata', function (e) {
        if (firstTimeEEZ && e.sourceId === 'eez-source' && e.isSourceLoaded) {
            map.getSource(e.sourceId).getData().then(
                (data) => {
                    // Populate select dropdown with fetched data
                    locationSelect.innerHTML = ""; // Clear loading message
                    let opt = document.createElement("option");
                    opt.value = '---';
                    opt.textContent = 'Choose a location';
                    locationSelect.appendChild(opt);
                    for (var i = 0, ii = data.features.length; i < ii; i++) {
                        opt = document.createElement("option");
                        opt.value = data.features[i].properties.GEONAME;
                        opt.classList.add("fixed");
                        opt.textContent = data.features[i].properties.GEONAME;
                        locationSelect.appendChild(opt);
                    } 
                    // Initial EEZ
                    locationSelect.value = INITIAL_VIEW_STATE.EEZ;
                    locationSelect.dispatchEvent(new Event("change"));
                    
                }
            );
            firstTimeEEZ = false;
        }
    });

    // Add layers after the map loads
    map.on('load', () => {

        /*
         * [GeoJSON] Sargassum as heatmap
         */
        map.addSource('sargassum', {
            type: 'geojson',
            data: createGridFromPoints(sargassum.data)
        });
        
        map.addLayer({
            type: 'fill',
            id: 'sargassum-layer',
            source: 'sargassum',
            paint: {
                'fill-color': [
                    'interpolate',
                    ['linear'],
                    ['get', 'value'],
                    0, 'transparent',  // Yellow for value = 0
                    0.1, 'rgba(255,255,0,1)',  // Yellow for value = 0
                    0.7, 'rgba(255,0,0,1)'   // Red for value = 1
                ],
                'fill-opacity': 1,
                'fill-outline-color': 'transparent'
            }
        });

        map.addSource('eez-source', {
            type: 'geojson',
            data: 'data/eez_reduced.json'
        });
        map.addLayer({
            id: 'eez-layer',
            type: 'fill',
            source: 'eez-source',
            paint: {
                'fill-outline-color':[
                    'case',
                    ['boolean', ['feature-state', 'click'], false],
                    'black',
                    'black'
                ],
                'fill-color': [
                    'case',
                    ['boolean', ['feature-state', 'click'], false],
                    'rgba(0,0,0,0.1)',
                    ['boolean', ['feature-state', 'hover'], false],
                    'rgba(0,0,0,0.1)',
                    'rgba(0,0,0,0)'
                ]
            }
        });

    });


    map.addControl(new maplibregl.FullscreenControl());

    // Initial layer loading
    updateDate(parseInt(dateSlider.value, 10), true);

})();

/** ========================== [UI] Chart ================================ **/
let chartData;

// Handle threshold input changes
document.getElementById('sargassumThresholdInput').addEventListener('keypress', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault(); // Prevent form submission
        sargassumThresholdValue = parseFloat(event.target.value);
        updateChart();
    }
});

Chart.defaults.color = '#ffffff';
const ctx = document.getElementById('timeChart').getContext('2d');
const timeChart = new Chart(ctx, {
    data: {
        datasets: [
            {
                id: 'currentForecast',
                type: 'line',
                label: 'Current forecast',
                data: [],
                tension: 0.4,
                borderColor:'yellow',
                segment: {
                    backgroundColor: ctx => getSegmentColor(ctx),
                    borderColor: ctx => getSegmentColor(ctx),
                },
                pointBackgroundColor: 'transparent',
                pointBorderColor: 'transparent',
                pointRadius: 5,
                fill: true
            }
        ]
    },
    options: {
        responsive: true,
        animation: false,
        maintainAspectRatio:false,
        parsing: {
            xAxisKey: "time",
            yAxisKey: "value",
        },
        plugins: {
            legend: {
                display: true
            },
            annotation: {
                annotations: [
                    {
                        type: 'line',
                        yMin: sargassumThresholdValue,
                        yMax: sargassumThresholdValue,
                        borderColor: 'white',
                        borderWidth: 2,
                        borderDash: [5, 5],
                        label: {
                            enabled: true,
                            content: `Threshold: ${sargassumThresholdValue}`,
                            position: 'end'
                        }
                    }
                ]
            }
        },
        scales: {
            x: {
                type: 'time',
                time: { unit: 'month' }, // Display by day
                title: { display: false, text: 'Date' },
                gridLines: {
                    display: false
                }
            },
            y: {
                title: { display: true, text: 'Sargassum density in m2/km2' },
                gridLines: {
                    display: false
                }
            }
        },
        onClick: (e) => {
            const points = timeChart.getElementsAtEventForMode(e, 'nearest', { intersect: true }, true);
            if (points.length) {
                const firstPoint = points[0];
                // Find the index in the time array
                for (var i = 0, ii = chartData.length; i < ii; i++) {
                    if (chartData[i].time.getTime() === startDate.getTime()) {
                        return updateDate(firstPoint.index - i, true);
                    }
                }
            }
        }
    }
});

// Function to dynamically color segments above threshold
function getSegmentColor(ctx) {
    const index = ctx.p1DataIndex;
    if (!chartData) {
        return;
    }
    
    if (chartData[index].time.toISOString().split('T')[0] === currentDate.toISOString().split('T')[0]) {
        return '#3D9970';
    }
    
    return chartData[index].value > sargassumThresholdValue ? '#FFDC00' : 'rgba(255,220,0,0.4)';
}


// Function to update chart dynamically
function updateChart() {

    // Update threshold line position
    timeChart.options.plugins.annotation.annotations[0].yMin = sargassumThresholdValue;
    timeChart.options.plugins.annotation.annotations[0].yMax = sargassumThresholdValue;
    
    timeChart.update();

    computeStatistics();
}

// Function to format date as ISO 8601 (`YYYY-MM-DD`)
function formatDateISO(date) {
    return date.toISOString().split('T')[0];
}

// Normalize the values between 0 and 1
function normalizeValue(value, minValue = 0.0001, maxValue = 0.2) {
    if (value <= minValue) {
        value = minValue;
    }
    if (value >= maxValue) {
        value = maxValue;
    }
    return (value - minValue) / (maxValue - minValue);
}

function logNormalizeValue(value, minValue = 0.0001, maxValue = 0.2) {
    if (value <= minValue) {
        value = minValue;
    }
    if (value >= maxValue) {
        value = maxValue;
    }
    // Apply logarithmic scaling
    return (Math.log(value - minValue + 1) / Math.log(maxValue - minValue + 1));
}

// Function to update the heatmap layer with the new GeoJSON
async function updateLayers(url) {
    if (isFetching) return; // Skip if another request is ongoing
    try {
        isFetching = true; // Mark request in progress
        fetchingSpinner.style.display = 'block';
        const response = await fetch(url);
        sargassum.data = await response.json();
        if (!sargassum.data.features) {
            sargassum.data = { type: 'FeatureCollection', features: [] };
        }
        for (const feature of sargassum.data.features) {
            feature.properties.value = logNormalizeValue(feature.properties.value);
        }
        isFetching = false; // Request finished
        fetchingSpinner.style.display = 'none';
        map.getSource('sargassum').setData(createGridFromPoints(sargassum.data));
    } catch (error) {
        console.error('Error loading GeoJSON:', error);
        isFetching = false;
        return null;
    }
}

// Update Date & Heatmap
async function updateDate(ANIMATION_DAY_OFFSET, _update) {
    dateSlider.value = ANIMATION_DAY_OFFSET;
    currentDate = new Date(startDate);
    currentDate.setDate(startDate.getDate() + ANIMATION_DAY_OFFSET);
    if (timeChart) {
        updateChart();
    }
    const isoDate = formatDateISO(currentDate);
    forecastUrl = API_FORECAST_ENDPOINT + isoDate;
    dateLabel.textContent = new Date(`${isoDate.split('T')[0]}`).toLocaleDateString();
    if (_update) {
        await updateLayers(forecastUrl);
    }
}

/**
 * Return the volume data for a specific EEZ
 * 
 * @param {string} eezName 
 */
async function fetchChartData(eezName) {
    try {

        let values = [];

        resetStatistics();
        
        if (eezName) {

            try {

                // Abort any previous request
                abortController.currentForecast.abort(); 
                abortController.currentForecast = new AbortController(); // Create new controller for new request
                
                // Hide spinner and show chart
                if (loadingSpinner && chartContainer) {
                    loadingSpinner.style.display = 'block';
                    chartContainer.style.display = 'none';
                }

                const response = await fetch(volumeUrl + eezName, {
                    signal: abortController.currentForecast.signal
                });
                const data = await response.json();
 
                // Convert API data into chart-friendly format
                if (currentEEZ) {
                    values = data.values.map((entry) => {
                        return {
                            time: new Date(entry.date),
                            value:entry.m2PerKm2
                        };
                    }); // Convert to Date objects
                }

                chartData = values;
                
                // Get the first date to retrieve previous forecast
                if (showPreviousForecast) {
                    getPreviousForecast();
                }

            } catch (err) {
                if (err.name == 'AbortError') { // gère abort()
                    console.log('Aborted');
                } else {
                    throw err;
                }
            }

        }

        // Hide spinner and show chart
        if (loadingSpinner && chartContainer) {
            loadingSpinner.style.display = 'none';
            chartContainer.style.display = 'block';
        }
        
        if (timeChart) {
            setDatasetData('currentForecast', chartData);
        }

    } catch (error) {
        loadingSpinner.style.display = 'none';
        chartContainer.style.display = 'block';
        console.error("Error fetching chart data:", error);
    }
}

function selectEEZ(geoname) {

    if (geoname === '---') {
        currentEEZ = null;
        eezArea.innerHTML = "Area:&nbsp; ---";
        return fetchChartData(null);
    }

    map.getSource('eez-source').getData().then(
        (data) => {
            if (data && data.features) {
                data.features.forEach(feature => {

                    if (feature.properties.GEONAME === geoname) {
    
                        currentEEZ = feature;
                        eezArea.innerHTML = "Area:&nbsp;" + feature.properties.AREA_KM2 + " km2";
                        const bbox = getBoundingBox(feature.geometry.coordinates);
                        map.fitBounds(bbox, {
                            padding: 200
                        });
                        
                        clickedStateId = feature.id;
                        map.setFeatureState(
                            {source: 'eez-source', id: clickedStateId},
                            {click: true}
                        );
    
                        return fetchChartData(geoname);
                    }
                    else {
                        map.setFeatureState(
                            {source: 'eez-source', id: feature.id},
                            {click: false}
                        );
                    }
                });
            }
        }
    )
}

function computeStatistics() {

    if ( !chartData || chartData.length === 0) {
        maximumValue.innerHTML = '---';
        coveringPeriod.innerHTML = '---';
        return;
    }

    let maximum = [null, -1];
    let intersections = [];
    let currentIntersection = null;
    for (let i = 0; i < chartData.length - 1; i++) {

        if (chartData[i].value > maximum[1]) {
            maximum = [chartData[i].time, chartData[i].value];
        }

        // Check if the data crosses the threshold
        if (!currentIntersection && chartData[i].value >= sargassumThresholdValue) {
            currentIntersection = {
                start: [chartData[i].time, chartData[i].value]
            }
        }

        if (currentIntersection && chartData[i].value <= sargassumThresholdValue) {
            currentIntersection.end = [chartData[i].time, chartData[i].value];
            intersections.push({
                start: [currentIntersection.start[0], currentIntersection.start[1]],
                end: [currentIntersection.end[0], currentIntersection.end[1]],
            })
            currentIntersection = null;
        }

    }

    if (currentIntersection) {
        intersections.push({
            start: [currentIntersection.start[0], currentIntersection.start[1]]
        });
    }
    
    // Maximum value and soccer field equivalence
    maximumValue.innerHTML = '<span class="hilite">' + toHumanDate(maximum[0]) + '</span>&nbsp;(' + parseInt(maximum[1]) + ' m2/km2)';

    visualMeasure.innerHTML = getVisualMeasure(maximum[1], currentEEZ.properties.AREA_KM2);

    let intersectionsValue = [];
    for (var i = 0, ii = intersections.length; i < ii; i++) {
        if (intersections[i].end) {
            intersectionsValue.push('From <span class="hilite">' + toHumanDate(intersections[i].start[0]) + '</span> to <span class="hilite">' + toHumanDate(intersections[i].end[0]) + '</span>')
        }
        else {
            intersectionsValue.push('From <span class="hilite">' + toHumanDate(intersections[i].start[0]) + '</span>');
        }
    }
    if (intersectionsValue.length > 0) {
        coveringPeriod.innerHTML = '<div style="padding-bottom:5px;">' + intersectionsValue.join('</div><div style="padding-bottom:5px;">') + '</div>';
    }
    return intersections;
}

function capitalizeFirstLetter(val) {
    return String(val).charAt(0).toUpperCase() + String(val).slice(1);
}

function resetStatistics() {
    maximumValue.innerHTML = '---';
    coveringPeriod.innerHTML = '---';
    visualMeasure.innerHTML = '';
    if (timeChart) {
        for (var i = timeChart.data.datasets.length; i--;) {
            timeChart.data.datasets[i].data = [];
        }
        timeChart.update();
    }
}

function toHumanDate(date) {
    return capitalizeFirstLetter(date.toLocaleDateString('en', { year: "numeric", month: "long", day: "2-digit" }));
}

/**
 * Concert m2/km2 into number of soccer field
 * 
 * @param {float} m2PerKm2 
 * @param {float} surfaceInKm2 
 */
function getVisualMeasure(m2PerKm2, surfaceInKm2) {
    let numberOfFields = parseInt((m2PerKm2 * surfaceInKm2) / 7000);
    let weight = parseInt(3.34 * m2PerKm2 * surfaceInKm2 / 1000);
    return numberOfFields + '&nbsp;x&nbsp;<img src="img/soccer_white.png" style="width:75px;"/><span style="padding-left:30px"></span><img src="img/weight_white.png" style="width:50px;"/>&nbsp;' + weight + '&nbsp;T';
}

// Function to calculate bounding box manually
function getBoundingBox(coordinates) {
    let minLng = Infinity, minLat = Infinity;
    let maxLng = -Infinity, maxLat = -Infinity;
    let lng, lat;
    coordinates[0].forEach(coord => {
        if ( Array.isArray(coord[0]) ) {
            coord.forEach(coord => {
                [lng, lat] = coord;
                if (lng < minLng) minLng = lng;
                if (lng > maxLng) maxLng = lng;
                if (lat < minLat) minLat = lat;
                if (lat > maxLat) maxLat = lat;
            });
        }
        else {
            [lng, lat] = coord;
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
        }
    });
    
    return [[minLng, minLat], [maxLng, maxLat]];
}

async function getPreviousForecast() {
    
    let values = [];

    if ( !chartData || !currentEEZ) {
        return;
    }

    let url = API_FORECAST_ENDPOINT + chartData[0].time.toISOString().split('T')[0] + '/volume/' + currentEEZ.properties.GEONAME
    
    try {

        // Abort any previous request
        if (abortController.previousForecast) {
            abortController.previousForecast.abort(); 
        }
        abortController.previousForecast = new AbortController(); // Create new controller for new request
        
        const response = await fetch(url, {
            signal: abortController.previousForecast.signal
        });
        const data = await response.json();
        
        const firstReferenceDate = chartData[0].time;
        const lastReferenceDate = chartData[chartData.length - 1].time;
        
        for (var i = 0, ii = data.values.length; i < ii; i++) {
            var date = new Date(data.values[i].date);
            if (date.getTime() < firstReferenceDate.getTime() || date.getTime() > lastReferenceDate.getTime()) {
                continue;
            }
            values.push({
                time:new Date(data.values[i].date),
                value:data.values[i].m2PerKm2
            });
        }

        if (timeChart) {
            let addDataset = true;
            for (var i = timeChart.data.datasets.length; i--;) {
                if (timeChart.data.datasets[i].id === 'previousForecast') {
                    addDataset = false;
                    break;
                }
            }
            if (addDataset) {
                timeChart.data.datasets.unshift({
                    id: 'previousForecast',
                    type: 'line',
                    label: 'Previous forecast',
                    data: [],
                    tension: 0.4,
                    borderColor: 'rgba(255,255,255,0.4)',
                    pointBackgroundColor: 'transparent',
                    pointBorderColor: 'transparent',
                    pointRadius: 5,
                    fill: false
                });
            }
            
            setDatasetData('previousForecast', values);
        }

    } catch (err) {
        if (err.name == 'AbortError') { // gère abort()
            console.log('Aborted');
        } else {
            throw err;
        }
    }

}

function setDatasetData(datasetName, data) {
    if (timeChart) {
        for (var i = 0, ii = timeChart.data.datasets.length; i < ii; i++) {
            if (timeChart.data.datasets[i].id === datasetName) {
                timeChart.data.datasets[i].data = data;
                updateChart(); // Refresh chart
                break;
            }
        }
    }

}

/**
 * Convert point GeoJSON to quarter-degree grid polygons
 */
function createGridFromPoints(pointGeoJson) {
    let gridFeatures = pointGeoJson.features.map(feature => {
        let [lon, lat] = feature.geometry.coordinates;
        let time = feature.properties.time;
        let value = feature.properties.value;

        // Quarter-degree grid boundaries
        let halfSize = 0.125; // 0.25° / 2
        let bbox = [
            [lon - halfSize, lat - halfSize],
            [lon + halfSize, lat - halfSize],
            [lon + halfSize, lat + halfSize],
            [lon - halfSize, lat + halfSize],
            [lon - halfSize, lat - halfSize] // Close the polygon
        ];

        return {
            type: 'Feature',
            geometry: {
                type: 'Polygon',
                coordinates: [bbox]
            },
            properties: { 
                value:value,
                time:time
            }
        };
    });

    return {
        type: 'FeatureCollection',
        features: gridFeatures
    };
}