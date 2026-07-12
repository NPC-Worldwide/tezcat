import React, { useState, useEffect, useCallback, useRef, useMemo, memo, lazy, Suspense } from 'react';
import {
    Save, Download, Upload, Plus, Trash2, X, Eye, Edit2, Layers,
    Search, Navigation, Ruler, FileJson, Globe, MapPin,
    ChevronDown, ChevronRight, EyeOff, Route, Hexagon, Circle,
    LocateFixed, Copy, Map as MapIcon, BookOpen
} from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Hide Leaflet attribution watermark
const leafletStyle = document.createElement('style');
leafletStyle.textContent = '.leaflet-control-attribution { display: none !important; }';
document.head.appendChild(leafletStyle);
import type {
    GISProject, GeoFeature, MapLayer, DrawMode, GISMapViewProps
} from 'npcts';
import {
    GISMapView, featuresToGeoJSON, geoJSONToFeatures,
    BASEMAPS, LAYER_COLORS, DEFAULT_PROJECT, REFERENCE_LAYERS, TILE_OVERLAYS,
    EarthView
} from 'npcts';
import { demoMaps } from '../lib/cartoglyphLibrary';

// ---- Proxy fetch through Electron main process (bypasses CORS) ----
async function proxyFetch(url: string, options?: any): Promise<Response> {
    const api = (window as any).api;
    if (api?.proxyFetch) {
        const result = await api.proxyFetch(url, options);
        const data = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
        return new Response(data, { status: result.status, headers: { 'content-type': 'application/json' } });
    }
    return fetch(url, options);
}

// ---- Weather OSINT helpers: fetch forecast geography as vector layers ----

const NWS_SEVERITY_COLOR: Record<string, string> = {
    extreme: '#7f1d1d',
    severe: '#ef4444',
    moderate: '#f97316',
    minor: '#eab308',
    unknown: '#94a3b8',
};

function nwsAlertColor(severity?: string): string {
    return NWS_SEVERITY_COLOR[(severity || 'unknown').toLowerCase()] || NWS_SEVERITY_COLOR.unknown;
}

async function fetchXML(url: string): Promise<Document> {
    const resp = await proxyFetch(url, { headers: { 'User-Agent': 'Incognide-Tezcat/1.0' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    return new DOMParser().parseFromString(text, 'text/xml');
}

async function fetchNWSAlerts(bounds: L.LatLngBounds): Promise<any[]> {
    const c = bounds.getCenter();
    const url = `https://api.weather.gov/alerts/active?status=actual&message_type=alert,update&point=${c.lat.toFixed(4)},${c.lng.toFixed(4)}`;
    const resp = await proxyFetch(url, { headers: { 'User-Agent': 'Incognide-Tezcat/1.0' } });
    if (!resp.ok) throw new Error(`NWS ${resp.status}`);
    const data = await resp.json();
    return (data.features || []).map((f: any) => {
        const props = f.properties || {};
        let lat = c.lat, lng = c.lng;
        let geometry = f.geometry;
        if (geometry?.type === 'Polygon' && geometry.coordinates?.[0]?.length) {
            const ring = geometry.coordinates[0];
            const [sumLng, sumLat] = ring.reduce((acc: [number, number], coord: number[]) => [acc[0] + coord[0], acc[1] + coord[1]], [0, 0]);
            lng = sumLng / ring.length;
            lat = sumLat / ring.length;
        }
        return {
            lat, lng,
            name: props.event || 'Weather Alert',
            source: 'nws',
            category: `weather:alert:${props.severity || 'unknown'}`,
            fullName: props.headline || props.areaDesc || props.description || '',
            color: nwsAlertColor(props.severity),
            geometry,
            tags: { ...props, source: 'nws' },
        };
    });
}

async function fetchWPCSurface(): Promise<any[]> {
    // WPC surface analysis KML: fronts, highs/lows, precipitation areas
    const url = 'https://www.wpc.ncep.noaa.gov/kml/sfc/all.kmz';
    try {
        const resp = await proxyFetch(url, { headers: { 'User-Agent': 'Incognide-Tezcat/1.0' } });
        if (!resp.ok) throw new Error(`WPC ${resp.status}`);
        const arrayBuffer = await resp.arrayBuffer();
        const zip = await import('jszip').then(m => m.default || m);
        const z = await zip.loadAsync(arrayBuffer);
        const kmlFile = Object.keys(z.files).find(n => n.endsWith('.kml'));
        if (!kmlFile) throw new Error('No KML in KMZ');
        const kmlText = await z.files[kmlFile].async('text');
        const doc = new DOMParser().parseFromString(kmlText, 'text/xml');
        const { kml } = await import('@tmcw/togeojson');
        const geojson = kml(doc);
        const out: any[] = [];
        (geojson.features || []).forEach((f: any, i: number) => {
            const props = f.properties || {};
            const name = props.name || `Surface ${i + 1}`;
            const desc = props.description || '';
            const color = desc.toLowerCase().includes('cold')
                ? '#3b82f6'
                : desc.toLowerCase().includes('warm')
                    ? '#ef4444'
                    : desc.toLowerCase().includes('occluded')
                        ? '#a855f7'
                        : desc.toLowerCase().includes('stationary')
                            ? '#22d3ee'
                            : '#f59e0b';
            let lat: number | undefined, lng: number | undefined;
            const geom = f.geometry;
            if (geom?.type === 'Point' && geom.coordinates) {
                [lng, lat] = geom.coordinates;
            } else if ((geom?.type === 'LineString' || geom?.type === 'Polygon') && geom.coordinates?.length) {
                const ring = geom.type === 'Polygon' ? geom.coordinates[0] : geom.coordinates;
                const [sumLng, sumLat] = ring.reduce((acc: [number, number], c: number[]) => [acc[0] + c[0], acc[1] + c[1]], [0, 0]);
                lng = sumLng / ring.length;
                lat = sumLat / ring.length;
            }
            out.push({
                id: `wpc_${i}`,
                name,
                source: 'wpc',
                category: `weather:surface:${(f.geometry?.type || 'unknown').toLowerCase()}`,
                color,
                geometry: geom,
                lat,
                lng,
                tags: { ...props, source: 'wpc' },
            });
        });
        return out;
    } catch (err) {
        console.error('WPC surface fetch error:', err);
        return [];
    }
}

async function fetchNHCStorms(): Promise<any[]> {
    // NHC active storms Atlantic + Pacific
    try {
        const resp = await proxyFetch('https://www.nhc.noaa.gov/ftp/pub/forecast/active/', { headers: { 'User-Agent': 'Incognide-Tezcat/1.0' } });
        // Active storm list is not a clean JSON endpoint; use the GIS feed instead.
        // NHC RSS feed + GIS shapefiles: https://www.nhc.noaa.gov/gis/
        const gisResp = await proxyFetch('https://www.nhc.noaa.gov/ftp/pub/forecast/advisories/', { headers: { 'User-Agent': 'Incognide-Tezcat/1.0' } });
        // Fallback: try the NHC GIS active storms GeoJSON (if available)
        const jsonResp = await proxyFetch('https://www.nhc.noaa.gov/CurrentStorms.json', { headers: { 'User-Agent': 'Incognide-Tezcat/1.0' } });
        if (!jsonResp.ok) throw new Error(`NHC ${jsonResp.status}`);
        const data = await jsonResp.json();
        const out: any[] = [];
        (data.activeStorms || []).forEach((s: any) => {
            const c = s.center || {};
            if (c.latitude != null && c.longitude != null) {
                out.push({
                    id: s.id,
                    name: `${s.name || s.stormName || 'Storm'} ${s.classification || ''}`,
                    source: 'nhc',
                    category: `weather:storm:${(s.classification || 'unknown').toLowerCase()}`,
                    color: s.classification?.toLowerCase().includes('hurricane') ? '#ef4444' : '#f97316',
                    lat: parseFloat(c.latitude),
                    lng: parseFloat(c.longitude),
                    tags: { ...s, source: 'nhc' },
                });
            }
        });
        return out;
    } catch (err) {
        console.error('NHC fetch error:', err);
        return [];
    }
}

// ---- KML parsing ----

async function parseKML(text: string): Promise<any> {
    const { kml } = await import('@tmcw/togeojson');
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    return kml(doc);
}

// ---- Weather forecast tile overlays ----
// RainViewer's public API returns a short path (e.g. /v2/radar/643d69b227de) per frame.
// Tile URLs are: {host}{path}/256/{z}/{x}/{y}/{color}/{smooth}_{snow}.png
// We leave {z}/{x}/{y} as Leaflet placeholders so every tile gets the right coordinates.
type RainViewerFrame = { time: number; path: string };
type RainViewerMeta = { host: string; radarFrame: RainViewerFrame; nowcastFrames: RainViewerFrame[] };

const WEATHER_LAYERS: Record<string, {
    name: string;
    getUrl: (forecastHour: number, meta?: RainViewerMeta) => string;
    opacity: number;
    forecastable: boolean;
    bounds?: [[number, number], [number, number]];
    wms?: { layers: string; format?: string; transparent?: boolean };
}> = {
    radar: {
        name: 'NEXRAD Radar',
        getUrl: (_h, meta) => meta?.radarFrame?.path
            ? `${meta.host}${meta.radarFrame.path}/256/{z}/{x}/{y}/2/1_1.png`
            : '',
        opacity: 0.65,
        forecastable: false,
    },
    precip_nowcast: {
        name: 'Precip Nowcast',
        getUrl: (h, meta) => {
            // RainViewer nowcast frames are ~10-minute intervals. Prefer those when available.
            const frames = meta?.nowcastFrames || [];
            if (frames.length) {
                const idx = Math.min(Math.max(0, Math.round(h * 6)), frames.length - 1);
                const frame = frames[idx];
                return frame?.path ? `${meta!.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png` : '';
            }
            // Fallback: IEM HRRR forecast reflectivity (FXXXX is forecast minute, 0-1080 / 18 h)
            const minute = Math.min(Math.round(h * 60), 1080);
            const f = minute.toString().padStart(4, '0');
            return `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/hrrr::REFD-F${f}-0/{z}/{x}/{y}.png`;
        },
        opacity: 0.65,
        forecastable: true,
    },
    satellite: {
        name: 'GOES Satellite',
        getUrl: () => `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/goes_east_conus_ch13/{z}/{x}/{y}.png`,
        opacity: 0.6,
        forecastable: false,
        bounds: [[24.0, -107.0], [50.0, -60.0]],
    },
    warnings: {
        name: 'NWS Warnings',
        getUrl: () => `https://mesonet.agron.iastate.edu/cgi-bin/wms/us/wwa.cgi`,
        opacity: 0.65,
        forecastable: false,
        wms: { layers: 'warnings_p', format: 'image/png', transparent: true },
    },
};


// ---- Main wrapper component ----

type ActiveTab = 'gis' | 'globe';

const Tezcat = ({ filePath: propFilePath }: { filePath?: string }) => {
    const [activeTab, setActiveTab] = useState<ActiveTab>('gis');

    // GIS state
    const [project, setProject] = useState<GISProject>({ ...DEFAULT_PROJECT });
    const [mode, setMode] = useState<DrawMode>('select');
    const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
    const [hasChanges, setHasChanges] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [sidebarTab, setSidebarTab] = useState<'layers' | 'properties' | 'osint' | 'overlays' | 'weather'>('layers');
    const [activeOverlays, setActiveOverlays] = useState<Set<string>>(new Set());
    const [activeTileOverlays, setActiveTileOverlays] = useState<Set<string>>(new Set());
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [activeLayerId, setActiveLayerId] = useState('default');

    // Weather forecast overlays
    const [activeWeatherLayers, setActiveWeatherLayers] = useState<Set<string>>(new Set());
    const [forecastHour, setForecastHour] = useState(0);
    const [rainViewerMeta, setRainViewerMeta] = useState<RainViewerMeta | null>(null);
    const weatherLayerRefs = useRef<Record<string, L.Layer>>({});

    // OSINT auto-cache
    const [osintCache, setOsintCache] = useState<Record<string, { results: any[]; bbox: string }>>({});
    const [osintVisible, setOsintVisible] = useState<Set<string>>(new Set());
    const [osintLoading, setOsintLoading] = useState<Set<string>>(new Set());

    // Search
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<any[]>([]);
    const [isSearching, setIsSearching] = useState(false);

    // OSINT
    const [osintQuery, setOsintQuery] = useState('');
    const [osintResults, setOsintResults] = useState<any[]>([]);
    const [isOsintLoading, setIsOsintLoading] = useState(false);
    const [osintType, setOsintType] = useState<'nominatim' | 'overpass'>('nominatim');

    // Menus
    const [showExportMenu, setShowExportMenu] = useState(false);
    const [showBasemapMenu, setShowBasemapMenu] = useState(false);
    const [showImportMenu, setShowImportMenu] = useState(false);
    const [showSamplesMenu, setShowSamplesMenu] = useState(false);

    // Feature editing
    const [editingFeatureName, setEditingFeatureName] = useState<string | null>(null);
    const [editNameValue, setEditNameValue] = useState('');

    const mapRef = useRef<L.Map | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // OSINT preset categories
    const OSINT_PRESETS: Record<string, { label: string; color: string; category: string; query?: string; source?: 'overpass' | 'nws' | 'wpc' | 'nhc'; geomType?: 'marker' | 'polygon' | 'line' }> = useMemo(() => ({
        hospitals: { label: 'Hospitals', query: 'amenity=hospital', color: '#ef4444', category: 'emergency', source: 'overpass' },
        police: { label: 'Police', query: 'amenity=police', color: '#3b82f6', category: 'emergency', source: 'overpass' },
        fire_stations: { label: 'Fire Stations', query: 'amenity=fire_station', color: '#f97316', category: 'emergency', source: 'overpass' },
        pharmacies: { label: 'Pharmacies', query: 'amenity=pharmacy', color: '#10b981', category: 'emergency', source: 'overpass' },
        schools: { label: 'Schools', query: 'amenity=school', color: '#8b5cf6', category: 'civic', source: 'overpass' },
        banks: { label: 'Banks', query: 'amenity=bank', color: '#eab308', category: 'civic', source: 'overpass' },
        embassies: { label: 'Embassies', query: 'amenity=embassy', color: '#06b6d4', category: 'civic', source: 'overpass' },
        prisons: { label: 'Prisons', query: 'amenity=prison', color: '#64748b', category: 'civic', source: 'overpass' },
        government: { label: 'Government', query: 'office=government', color: '#a855f7', category: 'civic', source: 'overpass' },
        military: { label: 'Military', query: 'military=yes', color: '#78716c', category: 'security', source: 'overpass' },
        cameras: { label: 'Surveillance', query: 'man_made=surveillance', color: '#f43f5e', category: 'security', source: 'overpass' },
        cell_towers: { label: 'Cell Towers', query: 'telecom=mast', color: '#d946ef', category: 'infrastructure', source: 'overpass' },
        power_plants: { label: 'Power Plants', query: 'power=plant', color: '#facc15', category: 'infrastructure', source: 'overpass' },
        gas_stations: { label: 'Gas Stations', query: 'amenity=fuel', color: '#fb923c', category: 'infrastructure', source: 'overpass' },
        water_towers: { label: 'Water Towers', query: 'man_made=water_tower', color: '#38bdf8', category: 'infrastructure', source: 'overpass' },
        helipads: { label: 'Helipads', query: 'aeroway=helipad', color: '#a3e635', category: 'transport', source: 'overpass' },
        hotels: { label: 'Hotels', query: 'tourism=hotel', color: '#c084fc', category: 'commercial', source: 'overpass' },
        restaurants: { label: 'Restaurants', query: 'amenity=restaurant', color: '#fb7185', category: 'commercial', source: 'overpass' },
        bridges: { label: 'Bridges', query: 'man_made=bridge', color: '#94a3b8', category: 'infrastructure', source: 'overpass' },
        dams: { label: 'Dams', query: 'waterway=dam', color: '#22d3ee', category: 'infrastructure', source: 'overpass' },
        // Weather/environment OSINT (fetchable vector geography)
        weather_stations: { label: 'Weather Stations', query: 'man_made=weather_station', color: '#60a5fa', category: 'environment', source: 'overpass' },
        nws_alerts: { label: 'NWS Alerts (polygons)', color: '#ef4444', category: 'environment', source: 'nws', geomType: 'polygon' },
        wpc_surface: { label: 'WPC Surface Analysis (fronts)', color: '#22d3ee', category: 'environment', source: 'wpc', geomType: 'line' },
        nhc_storms: { label: 'NHC Active Storms', color: '#f97316', category: 'environment', source: 'nhc', geomType: 'marker' },
    }), []);

    // Fetch a single OSINT category for current viewport
    const fetchOsintCategory = useCallback(async (key: string) => {
        const preset = OSINT_PRESETS[key];
        if (!preset || !mapRef.current) return;
        const bounds = mapRef.current.getBounds();
        const bbox = `${bounds.getSouth().toFixed(2)},${bounds.getWest().toFixed(2)},${bounds.getNorth().toFixed(2)},${bounds.getEast().toFixed(2)}`;
        // Skip if already cached for this bbox
        if (osintCache[key]?.bbox === bbox) return;
        setOsintLoading(prev => new Set(prev).add(key));
        try {
            let results: any[] = [];
            if (preset.source === 'nws') {
                results = await fetchNWSAlerts(bounds);
            } else if (preset.source === 'wpc') {
                results = await fetchWPCSurface();
            } else if (preset.source === 'nhc') {
                results = await fetchNHCStorms();
            } else {
                // Overpass rejects very large bboxes (HTTP 406). Skip if view is too wide.
                const area = (bounds.getNorth() - bounds.getSouth()) * (bounds.getEast() - bounds.getWest());
                if (area > 25) {
                    console.warn(`OSINT ${key}: viewport too large for Overpass, zoom in`);
                    setOsintLoading(prev => { const s = new Set(prev); s.delete(key); return s; });
                    return;
                }
                const parts = (preset.query || '').split('=');
                const tagFilter = parts[1] ? `["${parts[0]}"="${parts[1]}"]` : `["${parts[0]}"]`;
                const s = bounds.getSouth(), w = bounds.getWest(), n = bounds.getNorth(), e = bounds.getEast();
                const q = `[out:json][timeout:25];(node${tagFilter}(${s},${w},${n},${e});way${tagFilter}(${s},${w},${n},${e}););out center body 200;`;
                const resp = await proxyFetch('https://overpass-api.de/api/interpreter', {
                    method: 'POST',
                    body: `data=${encodeURIComponent(q)}`,
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                });
                if (!resp.ok) throw new Error(`Overpass ${resp.status}`);
                const data = await resp.json();
                results = (data.elements || []).map((el: any) => ({
                    lat: el.lat || el.center?.lat,
                    lng: el.lon || el.center?.lon,
                    name: el.tags?.name || `${el.type}/${el.id}`,
                    source: 'overpass',
                    category: el.tags?.amenity || el.tags?.shop || el.tags?.building || 'unknown',
                    tags: el.tags || {},
                })).filter((r: any) => r.lat && r.lng);
            }
            setOsintCache(prev => ({ ...prev, [key]: { results, bbox } }));
        } catch (err) {
            console.error(`OSINT fetch ${key}:`, err);
        } finally {
            setOsintLoading(prev => { const s = new Set(prev); s.delete(key); return s; });
        }
    }, [OSINT_PRESETS, osintCache]);

    // Toggle an OSINT layer — fetch if needed, then show/hide
    const toggleOsintLayer = useCallback((key: string) => {
        setOsintVisible(prev => {
            const next = new Set(prev);
            if (next.has(key)) { next.delete(key); } else { next.add(key); fetchOsintCategory(key); }
            return next;
        });
    }, [fetchOsintCategory]);

    // Re-fetch visible OSINT layers when map moves significantly
    const lastOsintFetchBbox = useRef<string>('');
    const osintRefreshTimer = useRef<any>(null);

    const scheduleOsintRefresh = useCallback(() => {
        if (osintRefreshTimer.current) clearTimeout(osintRefreshTimer.current);
        osintRefreshTimer.current = setTimeout(() => {
            if (!mapRef.current || osintVisible.size === 0) return;
            const bounds = mapRef.current.getBounds();
            const bbox = `${bounds.getSouth().toFixed(1)},${bounds.getWest().toFixed(1)},${bounds.getNorth().toFixed(1)},${bounds.getEast().toFixed(1)}`;
            if (bbox === lastOsintFetchBbox.current) return;
            lastOsintFetchBbox.current = bbox;
            osintVisible.forEach(key => fetchOsintCategory(key));
        }, 2000);
    }, [osintVisible, fetchOsintCategory]);

    // Hook into map move
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        const handler = () => scheduleOsintRefresh();
        map.on('moveend', handler);
        return () => { map.off('moveend', handler); };
    }, [scheduleOsintRefresh]);

    // Fetch RainViewer metadata when a RainViewer layer is active
    useEffect(() => {
        const needRainViewer = activeWeatherLayers.has('radar') || activeWeatherLayers.has('precip_nowcast');
        if (!needRainViewer) return;
        if (rainViewerMeta) return;
        const load = async () => {
            try {
                const resp = await proxyFetch('https://api.rainviewer.com/public/weather-maps.json');
                if (!resp.ok) throw new Error(`RainViewer ${resp.status}`);
                const data = await resp.json();
                const host = data.host || 'https://tilecache.rainviewer.com';
                const past = data.radar?.past || [];
                const nowcast = data.radar?.nowcast || data.nowcast || [];
                const radarFrame = past.length ? past[past.length - 1] : null;
                const nowcastFrames = nowcast.map((f: any) => ({ time: f.time, path: f.path }));
                if (radarFrame?.path) {
                    setRainViewerMeta({ host, radarFrame, nowcastFrames });
                }
            } catch (err) {
                console.error('RainViewer meta fetch:', err);
            }
        };
        load();
    }, [activeWeatherLayers, rainViewerMeta]);

    // Add/remove weather tile overlays
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        Object.entries(WEATHER_LAYERS).forEach(([key, def]) => {
            if (!activeWeatherLayers.has(key)) {
                if (weatherLayerRefs.current[key]) {
                    map.removeLayer(weatherLayerRefs.current[key]);
                    delete weatherLayerRefs.current[key];
                }
                return;
            }
            const baseUrl = def.getUrl(forecastHour, rainViewerMeta || undefined);
            if (!baseUrl) return; // wait for RainViewer meta
            if (weatherLayerRefs.current[key]) {
                map.removeLayer(weatherLayerRefs.current[key]);
                delete weatherLayerRefs.current[key];
            }
            const layer = def.wms
                ? L.tileLayer.wms(baseUrl, {
                    layers: def.wms.layers,
                    format: def.wms.format || 'image/png',
                    transparent: def.wms.transparent !== false,
                    opacity: def.opacity,
                    bounds: def.bounds,
                })
                : L.tileLayer(baseUrl, { opacity: def.opacity, bounds: def.bounds });
            layer.addTo(map);
            weatherLayerRefs.current[key] = layer;
        });
        return () => {
            Object.values(weatherLayerRefs.current).forEach(l => { try { map.removeLayer(l); } catch {} });
            weatherLayerRefs.current = {};
        };
    }, [activeWeatherLayers, forecastHour, rainViewerMeta]);

    const filePath = propFilePath;
    const isStandalone = !filePath || filePath === 'cartoglyph';

    // Load project
    useEffect(() => {
        if (isStandalone) return;
        const load = async () => {
            try {
                const response = await (window as any).api?.readFile?.(filePath);
                if (response && !response.error) {
                    const content = response.content || response;
                    const data = JSON.parse(content);
                    if (data.version === 2) {
                        setProject(data);
                        setActiveTab('gis');
                    }
                }
            } catch (err) {
                console.error('Error loading map:', err);
            }
        };
        load();
    }, [filePath, isStandalone]);

    // Save
    const saveProject = useCallback(async () => {
        if (isStandalone) return;
        setIsSaving(true);
        try {
            await (window as any).api?.writeFile?.(filePath, JSON.stringify(project, null, 2));
            setHasChanges(false);
        } catch (err) {
            console.error('Error saving:', err);
        } finally {
            setIsSaving(false);
        }
    }, [filePath, project, isStandalone]);

    const updateProject = useCallback((updater: (prev: GISProject) => GISProject) => {
        setProject(prev => {
            const next = updater(prev);
            setHasChanges(true);
            return next;
        });
    }, []);

    // ---- Feature/Layer ops ----

    const updateFeature = useCallback((id: string, updates: Partial<GeoFeature>) => {
        updateProject(prev => ({ ...prev, features: prev.features.map(f => f.id === id ? { ...f, ...updates } : f) }));
    }, [updateProject]);

    const deleteFeature = useCallback((id: string) => {
        updateProject(prev => ({
            ...prev,
            features: prev.features.filter(f => f.id !== id),
            layers: prev.layers.map(l => ({ ...l, features: l.features.filter(fid => fid !== id) })),
        }));
        if (selectedFeatureId === id) setSelectedFeatureId(null);
    }, [updateProject, selectedFeatureId]);

    const addLayer = useCallback(() => {
        const id = `layer_${Date.now()}`;
        const color = LAYER_COLORS[project.layers.length % LAYER_COLORS.length];
        updateProject(prev => ({ ...prev, layers: [...prev.layers, { id, name: `Layer ${prev.layers.length + 1}`, visible: true, color, features: [], locked: false }] }));
        setActiveLayerId(id);
    }, [updateProject, project.layers.length]);

    const deleteLayer = useCallback((layerId: string) => {
        if (project.layers.length <= 1) return;
        updateProject(prev => ({
            ...prev,
            features: prev.features.filter(f => f.layerId !== layerId),
            layers: prev.layers.filter(l => l.id !== layerId),
        }));
        if (activeLayerId === layerId) setActiveLayerId(project.layers.find(l => l.id !== layerId)?.id || 'default');
    }, [updateProject, project.layers, activeLayerId]);

    const toggleLayerVisibility = useCallback((layerId: string) => {
        updateProject(prev => ({ ...prev, layers: prev.layers.map(l => l.id === layerId ? { ...l, visible: !l.visible } : l) }));
    }, [updateProject]);

    // ---- Search ----

    const handleSearch = useCallback(async () => {
        if (!searchQuery.trim()) return;
        setIsSearching(true);
        try {
            const resp = await proxyFetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=8`, {
                headers: { 'User-Agent': 'Incognide-Cartoglyph/1.0' },
            });
            setSearchResults(await resp.json());
        } catch (err) { console.error('Search error:', err); }
        finally { setIsSearching(false); }
    }, [searchQuery]);

    const goToResult = useCallback((r: any) => {
        mapRef.current?.setView([parseFloat(r.lat), parseFloat(r.lon)], 14);
        setSearchResults([]);
        setSearchQuery('');
    }, []);

    const addResultAsMarker = useCallback((r: any) => {
        const lat = parseFloat(r.lat), lng = parseFloat(r.lon);
        const id = `feat_${Date.now()}`;
        const layer = project.layers.find(l => l.id === activeLayerId);
        updateProject(prev => ({
            ...prev,
            features: [...prev.features, { id, type: 'marker' as const, name: r.display_name?.split(',')[0] || 'Location', coordinates: [lat, lng] as [number, number], color: layer?.color || '#3b82f6', visible: true, layerId: activeLayerId, properties: { source: 'nominatim', display_name: r.display_name } }],
            layers: prev.layers.map(l => l.id === activeLayerId ? { ...l, features: [...l.features, id] } : l),
        }));
        mapRef.current?.setView([lat, lng], 14);
        setSearchResults([]);
        setSearchQuery('');
    }, [activeLayerId, project.layers, updateProject]);

    // ---- OSINT ----

    const fetchOSINT = useCallback(async (queryOverride?: string, typeOverride?: 'nominatim' | 'overpass') => {
        const q = queryOverride || osintQuery;
        const t = typeOverride || osintType;
        if (!q.trim()) return;
        setIsOsintLoading(true);
        setOsintResults([]);
        try {
            if (t === 'nominatim') {
                const resp = await proxyFetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=20&addressdetails=1`, {
                    headers: { 'User-Agent': 'Incognide-Cartoglyph/1.0' },
                });
                const data = await resp.json();
                setOsintResults(data.map((r: any) => ({
                    id: r.osm_id, name: r.display_name?.split(',')[0], fullName: r.display_name,
                    lat: parseFloat(r.lat), lng: parseFloat(r.lon), type: r.type, category: r.class, source: 'nominatim',
                })));
            } else {
                // Overpass — use proper QL format
                const bounds = mapRef.current?.getBounds();
                if (!bounds) { setIsOsintLoading(false); return; }
                const s = bounds.getSouth(), w = bounds.getWest(), n = bounds.getNorth(), e = bounds.getEast();
                // Parse "key=value" format from user
                const parts = q.split('=');
                const key = parts[0]?.trim();
                const val = parts[1]?.trim();
                const tagFilter = val ? `["${key}"="${val}"]` : `["${key}"]`;
                const query = `[out:json][timeout:25];(node${tagFilter}(${s},${w},${n},${e});way${tagFilter}(${s},${w},${n},${e}););out center body 50;`;
                const resp = await proxyFetch('https://overpass-api.de/api/interpreter', {
                    method: 'POST',
                    body: `data=${encodeURIComponent(query)}`,
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                });
                if (!resp.ok) throw new Error(`Overpass returned ${resp.status}`);
                const data = await resp.json();
                setOsintResults((data.elements || []).map((el: any) => ({
                    id: el.id, name: el.tags?.name || `${el.type}/${el.id}`,
                    fullName: Object.entries(el.tags || {}).map(([k, v]) => `${k}=${v}`).join(', '),
                    lat: el.lat || el.center?.lat, lng: el.lon || el.center?.lon,
                    type: el.type, category: el.tags?.amenity || el.tags?.shop || el.tags?.building || 'unknown', source: 'overpass',
                })));
            }
        } catch (err) { console.error('OSINT fetch error:', err); }
        finally { setIsOsintLoading(false); }
    }, [osintQuery, osintType]);

    const addOsintResult = useCallback((r: any) => {
        const id = `osint_${Date.now()}_${r.id || Math.random().toString(36).slice(2, 8)}`;
        const color = r.color || '#f59e0b';
        let feature: GeoFeature;
        if (r.geometry?.type === 'Polygon' || r.geometry?.type === 'MultiPolygon') {
            const ring = r.geometry.type === 'Polygon'
                ? r.geometry.coordinates[0]
                : r.geometry.coordinates[0][0];
            feature = {
                id, type: 'polygon', name: r.name, color, visible: true, layerId: activeLayerId,
                coordinates: ring.map((c: number[]) => [c[1], c[0]] as [number, number]),
                properties: { source: r.source, category: r.category, ...(r.tags || {}) },
            };
        } else if (r.geometry?.type === 'LineString' || r.geometry?.type === 'MultiLineString') {
            const coords = r.geometry.type === 'LineString'
                ? r.geometry.coordinates
                : r.geometry.coordinates[0];
            feature = {
                id, type: 'line', name: r.name, color, visible: true, layerId: activeLayerId,
                coordinates: coords.map((c: number[]) => [c[1], c[0]] as [number, number]),
                properties: { source: r.source, category: r.category, ...(r.tags || {}) },
            };
        } else {
            if (!r.lat || !r.lng) return;
            feature = {
                id, type: 'marker', name: r.name, color, visible: true, layerId: activeLayerId,
                coordinates: [r.lat, r.lng] as [number, number],
                properties: { source: r.source, category: r.category, ...(r.tags || {}) },
            };
        }
        updateProject(prev => ({
            ...prev,
            features: [...prev.features, feature],
            layers: prev.layers.map(l => l.id === activeLayerId ? { ...l, features: [...l.features, id] } : l),
        }));
    }, [activeLayerId, updateProject]);

    // ---- Import/Export ----

    const handleFileImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const text = await file.text();
        const ext = file.name.split('.').pop()?.toLowerCase();
        const layerColor = LAYER_COLORS[project.layers.length % LAYER_COLORS.length];
        const newLayerId = `import_${Date.now()}`;
        let features: GeoFeature[] = [];

        try {
            if (ext === 'geojson' || ext === 'json') {
                features = geoJSONToFeatures(JSON.parse(text), newLayerId, layerColor);
            } else if (ext === 'kml' || ext === 'kmz') {
                features = geoJSONToFeatures(await parseKML(text), newLayerId, layerColor);
            } else if (ext === 'gpx') {
                const { gpx: gpxParser } = await import('@tmcw/togeojson');
                const parser = new DOMParser();
                const doc = parser.parseFromString(text, 'text/xml');
                const geojson = gpxParser(doc);
                features = geoJSONToFeatures(geojson, newLayerId, layerColor);
            } else if (ext === 'csv' || ext === 'tsv') {
                const lines = text.trim().split('\n');
                const sep = ext === 'tsv' ? '\t' : ',';
                const headers = lines[0].split(sep).map(h => h.trim().toLowerCase());
                const latIdx = headers.findIndex(h => ['lat', 'latitude', 'y'].includes(h));
                const lngIdx = headers.findIndex(h => ['lng', 'lon', 'longitude', 'x'].includes(h));
                const nameIdx = headers.findIndex(h => ['name', 'label', 'title'].includes(h));
                if (latIdx >= 0 && lngIdx >= 0) {
                    features = lines.slice(1).map((line, i) => {
                        const cols = line.split(sep).map(c => c.trim());
                        const lat = parseFloat(cols[latIdx]), lng = parseFloat(cols[lngIdx]);
                        if (isNaN(lat) || isNaN(lng)) return null;
                        return { id: `csv_${Date.now()}_${i}`, type: 'marker' as const, name: nameIdx >= 0 ? cols[nameIdx] : `Point ${i + 1}`, coordinates: [lat, lng] as [number, number], color: layerColor, visible: true, layerId: newLayerId, properties: Object.fromEntries(headers.map((h, hi) => [h, cols[hi]])) };
                    }).filter(Boolean) as GeoFeature[];
                }
            }
        } catch (err) { console.error('Import error:', err); return; }

        if (features.length > 0) {
            updateProject(prev => ({
                ...prev,
                layers: [...prev.layers, { id: newLayerId, name: file.name.replace(/\.[^.]+$/, ''), visible: true, color: layerColor, features: features.map(f => f.id), locked: false }],
                features: [...prev.features, ...features],
            }));
            const coords: [number, number][] = [];
            features.forEach(f => { if (Array.isArray(f.coordinates[0])) (f.coordinates as [number, number][]).forEach(c => coords.push(c)); else coords.push(f.coordinates as [number, number]); });
            if (coords.length > 0 && mapRef.current) mapRef.current.fitBounds(L.latLngBounds(coords.map(c => [c[0], c[1]])), { padding: [50, 50] });
        }
        setShowImportMenu(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
    }, [project.layers.length, updateProject]);

    const exportGeoJSON = useCallback(() => {
        const blob = new Blob([JSON.stringify(featuresToGeoJSON(project.features.filter(f => f.visible)), null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${project.name.replace(/\s+/g, '_')}.geojson`; a.click();
        setShowExportMenu(false);
    }, [project]);

    const exportKML = useCallback(async () => {
        const { default: tokmlFn } = await import('tokml');
        const kmlString = tokmlFn(featuresToGeoJSON(project.features.filter(f => f.visible)), 'default', {});
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([kmlString], { type: 'application/vnd.google-earth.kml+xml' })); a.download = `${project.name.replace(/\s+/g, '_')}.kml`; a.click();
        setShowExportMenu(false);
    }, [project]);

    const exportProject = useCallback(() => {
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })); a.download = `${project.name.replace(/\s+/g, '_')}.mapx`; a.click();
        setShowExportMenu(false);
    }, [project]);

    const selectedFeature = project.features.find(f => f.id === selectedFeatureId);

    const modeButtons: { m: DrawMode; icon: any; label: string }[] = [
        { m: 'select', icon: Navigation, label: 'Select' },
        { m: 'marker', icon: MapPin, label: 'Marker' },
        { m: 'line', icon: Route, label: 'Line' },
        { m: 'polygon', icon: Hexagon, label: 'Polygon' },
        { m: 'circle', icon: Circle, label: 'Circle' },
        { m: 'measure', icon: Ruler, label: 'Measure' },
    ];

    return (
        <div className="h-full w-full flex flex-col theme-bg-primary">
            {/* Tab bar + toolbar */}
            <div className="flex-shrink-0 border-b theme-border px-1.5 py-1 flex items-center gap-1.5 theme-bg-secondary">
                {/* Tab switcher */}
                <div className="flex items-center gap-0.5 px-1 py-0.5 theme-bg-tertiary rounded border theme-border mr-2">
                    <button onClick={() => setActiveTab('gis')} className={`px-2 py-1 rounded text-xs flex items-center gap-1 transition-colors ${activeTab === 'gis' ? 'bg-emerald-600 text-white' : 'theme-text-muted hover:theme-text-primary'}`}>
                        <MapIcon size={12} /> GIS Map
                    </button>
                    <button onClick={() => setActiveTab('globe')} className={`px-2 py-1 rounded text-xs flex items-center gap-1 transition-colors ${activeTab === 'globe' ? 'bg-emerald-600 text-white' : 'theme-text-muted hover:theme-text-primary'}`}>
                        <Globe size={12} /> Globe
                    </button>
                </div>

                {activeTab === 'gis' && (
                    <>
                        <input type="text" value={project.name} onChange={(e) => updateProject(prev => ({ ...prev, name: e.target.value }))}
                            className="px-2 py-1 text-sm theme-bg-tertiary theme-text-primary border theme-border rounded focus:border-emerald-500 focus:outline-none w-32" />
                        <div className="h-4 w-px theme-border-color bg-current opacity-30" />

                        {/* Mode buttons */}
                        <div className="flex items-center gap-0.5 px-1 py-0.5 theme-bg-tertiary rounded border theme-border">
                            {modeButtons.map(({ m, icon: Icon, label }) => (
                                <button key={m} onClick={() => setMode(m)} title={label}
                                    className={`px-1.5 py-1 rounded text-xs flex items-center gap-1 transition-colors ${mode === m ? 'bg-emerald-600 text-white' : 'theme-text-muted hover:theme-text-primary'}`}>
                                    <Icon size={14} />
                                </button>
                            ))}
                        </div>
                        <div className="flex-1" />

                        {/* Search */}
                        <div className="relative">
                            <div className="flex items-center gap-1">
                                <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()} placeholder="Search places..."
                                    className="px-2 py-1 text-xs theme-bg-tertiary theme-text-primary border theme-border rounded focus:border-emerald-500 focus:outline-none w-40" />
                                <button onClick={handleSearch} disabled={isSearching} className="p-1 theme-hover rounded theme-text-muted"><Search size={14} /></button>
                            </div>
                            {searchResults.length > 0 && (
                                <div className="absolute right-0 top-full mt-1 theme-bg-secondary border theme-border rounded shadow-xl z-[10000] max-h-60 overflow-y-auto w-80">
                                    {searchResults.map((r: any, i: number) => (
                                        <div key={i} className="flex items-center gap-1 px-2 py-1.5 hover:theme-bg-tertiary text-xs border-b theme-border last:border-0">
                                            <button onClick={() => goToResult(r)} className="flex-1 text-left theme-text-primary truncate">{r.display_name}</button>
                                            <button onClick={() => addResultAsMarker(r)} className="p-1 text-emerald-400 hover:text-emerald-300" title="Add as marker"><Plus size={12} /></button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                        <div className="h-4 w-px theme-border-color bg-current opacity-30" />

                        {/* Samples */}
                        <div className="relative">
                            <button onClick={() => setShowSamplesMenu(!showSamplesMenu)} className="p-1.5 theme-hover rounded theme-text-muted" title="Sample Maps"><BookOpen size={14} /></button>
                            {showSamplesMenu && (
                                <>
                                    <div className="fixed inset-0 z-[9999]" onMouseDown={() => setShowSamplesMenu(false)} />
                                    <div className="absolute right-0 top-full mt-1 theme-bg-secondary border theme-border rounded shadow-xl z-[10000] py-1 min-w-[280px] max-h-80 overflow-y-auto">
                                        <div className="px-3 py-1 text-[10px] theme-text-muted border-b theme-border">Load a sample map</div>
                                        {['travel', 'history', 'nature', 'infrastructure', 'intelligence'].map(cat => {
                                            const maps = demoMaps.filter(m => m.category === cat);
                                            if (maps.length === 0) return null;
                                            return (
                                                <div key={cat}>
                                                    <div className="px-3 pt-2 pb-0.5 text-[10px] theme-text-muted uppercase tracking-wider">{cat}</div>
                                                    {maps.map(m => (
                                                        <button key={m.title} onClick={() => {
                                                            setProject(m.project);
                                                            setHasChanges(false);
                                                            setShowSamplesMenu(false);
                                                            setTimeout(() => mapRef.current?.setView(m.center, m.zoom), 100);
                                                        }} className="flex flex-col px-3 py-1.5 w-full text-left hover:theme-bg-tertiary">
                                                            <span className="text-xs theme-text-primary font-medium">{m.title}</span>
                                                            <span className="text-[10px] theme-text-muted">{m.description} &middot; {m.featureCount} features</span>
                                                        </button>
                                                    ))}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </>
                            )}
                        </div>


                        {/* Import */}
                        <div className="relative">
                            <button onClick={() => setShowImportMenu(!showImportMenu)} className="p-1.5 theme-hover rounded theme-text-muted" title="Import"><Upload size={14} /></button>
                            {showImportMenu && (
                                <>
                                    <div className="fixed inset-0 z-[9999]" onMouseDown={() => setShowImportMenu(false)} />
                                    <div className="absolute right-0 top-full mt-1 theme-bg-secondary border theme-border rounded shadow-xl z-[10000] py-1 min-w-[260px]">
                                        <div className="px-3 py-1 text-[10px] theme-text-muted border-b theme-border">Import from file</div>
                                        <button onClick={() => { fileInputRef.current?.setAttribute('accept', '.geojson,.json'); fileInputRef.current?.click(); }} className="flex items-center gap-2 px-3 py-1.5 w-full text-left text-xs theme-text-primary hover:theme-bg-tertiary">
                                            <FileJson size={12} className="text-blue-400" /> <div><span className="font-medium">GeoJSON</span><br /><span className="text-[10px] theme-text-muted">Points, lines, polygons — ArcGIS/QGIS standard</span></div>
                                        </button>
                                        <button onClick={() => { fileInputRef.current?.setAttribute('accept', '.kml,.kmz'); fileInputRef.current?.click(); }} className="flex items-center gap-2 px-3 py-1.5 w-full text-left text-xs theme-text-primary hover:theme-bg-tertiary">
                                            <Globe size={12} className="text-green-400" /> <div><span className="font-medium">KML</span><br /><span className="text-[10px] theme-text-muted">Google Earth, Google Maps export</span></div>
                                        </button>
                                        <button onClick={() => { fileInputRef.current?.setAttribute('accept', '.gpx'); fileInputRef.current?.click(); }} className="flex items-center gap-2 px-3 py-1.5 w-full text-left text-xs theme-text-primary hover:theme-bg-tertiary">
                                            <Route size={12} className="text-orange-400" /> <div><span className="font-medium">GPX</span><br /><span className="text-[10px] theme-text-muted">GPS tracks — Garmin, Strava, AllTrails</span></div>
                                        </button>
                                        <button onClick={() => { fileInputRef.current?.setAttribute('accept', '.csv,.tsv'); fileInputRef.current?.click(); }} className="flex items-center gap-2 px-3 py-1.5 w-full text-left text-xs theme-text-primary hover:theme-bg-tertiary">
                                            <Layers size={12} className="text-yellow-400" /> <div><span className="font-medium">CSV / TSV</span><br /><span className="text-[10px] theme-text-muted">Spreadsheet with lat, lng, name columns</span></div>
                                        </button>
                                        <div className="border-t theme-border my-1" />
                                        <div className="px-3 py-1 text-[10px] theme-text-muted border-b theme-border">Download template</div>
                                        <button onClick={() => {
                                            const csv = 'name,lat,lng,description\nExample Point,40.7128,-74.0060,New York City\nAnother Point,34.0522,-118.2437,Los Angeles\n';
                                            const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'template_points.csv'; a.click(); setShowImportMenu(false);
                                        }} className="flex items-center gap-2 px-3 py-1.5 w-full text-left text-xs theme-text-muted hover:theme-bg-tertiary">
                                            <Download size={12} /> CSV template (points)
                                        </button>
                                        <button onClick={() => {
                                            const geojson = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-74.006, 40.7128] }, properties: { name: 'New York City' } }, { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-74.006, 40.7128], [-118.2437, 34.0522]] }, properties: { name: 'NYC to LA' } }] }, null, 2);
                                            const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([geojson], { type: 'application/json' })); a.download = 'template.geojson'; a.click(); setShowImportMenu(false);
                                        }} className="flex items-center gap-2 px-3 py-1.5 w-full text-left text-xs theme-text-muted hover:theme-bg-tertiary">
                                            <Download size={12} /> GeoJSON template (point + line)
                                        </button>
                                    </div>
                                </>
                            )}
                            <input ref={fileInputRef} type="file" accept=".geojson,.json,.kml,.csv,.gpx,.kmz,.tsv" className="hidden" onChange={handleFileImport} />
                        </div>

                        {/* Export */}
                        <div className="relative">
                            <button onClick={() => setShowExportMenu(!showExportMenu)} className="p-1.5 theme-hover rounded theme-text-muted" title="Export"><Download size={14} /></button>
                            {showExportMenu && (
                                <>
                                    <div className="fixed inset-0 z-[9999]" onMouseDown={() => setShowExportMenu(false)} />
                                    <div className="absolute right-0 top-full mt-1 theme-bg-secondary border theme-border rounded shadow-xl z-[10000] py-1 min-w-[260px]">
                                        <div className="px-3 py-1 text-[10px] theme-text-muted border-b theme-border">Export {project.features.length} features</div>
                                        <button onClick={exportGeoJSON} className="flex items-center gap-2 px-3 py-1.5 w-full text-left text-xs theme-text-primary hover:theme-bg-tertiary">
                                            <FileJson size={12} className="text-blue-400" /> <div><span className="font-medium">GeoJSON</span><br /><span className="text-[10px] theme-text-muted">Universal GIS format — open in ArcGIS, QGIS, Mapbox</span></div>
                                        </button>
                                        <button onClick={exportKML} className="flex items-center gap-2 px-3 py-1.5 w-full text-left text-xs theme-text-primary hover:theme-bg-tertiary">
                                            <Globe size={12} className="text-green-400" /> <div><span className="font-medium">KML</span><br /><span className="text-[10px] theme-text-muted">Google Earth / Google Maps</span></div>
                                        </button>
                                        <button onClick={() => {
                                            const markers = project.features.filter(f => f.visible && f.type === 'marker');
                                            const lines = ['name,lat,lng,type,color,layer'];
                                            markers.forEach(f => {
                                                const c = f.coordinates as [number, number];
                                                lines.push(`"${f.name.replace(/"/g, '""')}",${c[0]},${c[1]},${f.type},${f.color},${f.layerId}`);
                                            });
                                            const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = `${project.name.replace(/\s+/g, '_')}.csv`; a.click(); setShowExportMenu(false);
                                        }} className="flex items-center gap-2 px-3 py-1.5 w-full text-left text-xs theme-text-primary hover:theme-bg-tertiary">
                                            <Layers size={12} className="text-yellow-400" /> <div><span className="font-medium">CSV</span><br /><span className="text-[10px] theme-text-muted">Spreadsheet — markers only, with coordinates</span></div>
                                        </button>
                                        <button onClick={() => {
                                            const geojson = featuresToGeoJSON(project.features.filter(f => f.visible));
                                            let gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Cartoglyph">\n`;
                                            geojson.features.forEach((f: any) => {
                                                if (f.geometry.type === 'Point') {
                                                    gpx += `  <wpt lat="${f.geometry.coordinates[1]}" lon="${f.geometry.coordinates[0]}"><name>${f.properties?.name || ''}</name></wpt>\n`;
                                                } else if (f.geometry.type === 'LineString') {
                                                    gpx += `  <trk><name>${f.properties?.name || ''}</name><trkseg>\n`;
                                                    f.geometry.coordinates.forEach((c: number[]) => { gpx += `    <trkpt lat="${c[1]}" lon="${c[0]}"/>\n`; });
                                                    gpx += `  </trkseg></trk>\n`;
                                                }
                                            });
                                            gpx += `</gpx>`;
                                            const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' })); a.download = `${project.name.replace(/\s+/g, '_')}.gpx`; a.click(); setShowExportMenu(false);
                                        }} className="flex items-center gap-2 px-3 py-1.5 w-full text-left text-xs theme-text-primary hover:theme-bg-tertiary">
                                            <Route size={12} className="text-orange-400" /> <div><span className="font-medium">GPX</span><br /><span className="text-[10px] theme-text-muted">GPS exchange — Garmin, hiking apps, Strava</span></div>
                                        </button>
                                        <div className="border-t theme-border my-1" />
                                        <button onClick={exportProject} className="flex items-center gap-2 px-3 py-1.5 w-full text-left text-xs theme-text-primary hover:theme-bg-tertiary">
                                            <MapIcon size={12} className="text-emerald-400" /> <div><span className="font-medium">MAPX Project</span><br /><span className="text-[10px] theme-text-muted">Full project — layers, features, settings</span></div>
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>

                        {!isStandalone && (
                            <button onClick={saveProject} disabled={isSaving || !hasChanges} className="p-1.5 theme-hover rounded theme-text-muted disabled:opacity-50" title="Save"><Save size={14} /></button>
                        )}
                        <span className="text-xs theme-text-muted">{project.features.length} feat{hasChanges && <span className="text-yellow-500 ml-1">*</span>}</span>
                    </>
                )}

                <div className="flex-1" />
            </div>

            {/* Content */}
            {activeTab === 'gis' && (
                <div className="flex-1 flex overflow-hidden">
                    {/* Sidebar */}
                    {!sidebarCollapsed && (
                        <div className="w-60 border-r theme-border flex flex-col theme-bg-secondary overflow-hidden">
                            <div className="flex border-b theme-border">
                                {(['layers', 'properties', 'overlays', 'weather', 'osint'] as const).map(tab => (
                                    <button key={tab} onClick={() => setSidebarTab(tab)}
                                        className={`flex-1 px-2 py-1.5 text-xs transition-colors ${sidebarTab === tab ? 'text-emerald-400 border-b-2 border-emerald-400' : 'theme-text-muted hover:theme-text-primary'}`}>
                                        {tab === 'layers' ? 'Layers' : tab === 'properties' ? 'Props' : tab === 'overlays' ? 'Ref' : tab === 'weather' ? 'Wx' : 'OSINT'}
                                    </button>
                                ))}
                            </div>
                            <div className="flex-1 overflow-y-auto p-2">
                                {sidebarTab === 'layers' && (
                                    <div className="space-y-2">
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs font-medium theme-text-primary">Layers</span>
                                            <button onClick={addLayer} className="p-1 theme-hover rounded text-emerald-400"><Plus size={14} /></button>
                                        </div>
                                        {project.layers.map(layer => (
                                            <div key={layer.id} className={`border theme-border rounded p-2 ${activeLayerId === layer.id ? 'border-emerald-500/50 theme-bg-tertiary' : ''}`}>
                                                <div className="flex items-center gap-1.5">
                                                    <button onClick={() => toggleLayerVisibility(layer.id)} className="theme-text-muted hover:theme-text-primary">{layer.visible ? <Eye size={12} /> : <EyeOff size={12} />}</button>
                                                    <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: layer.color }} />
                                                    <button onClick={() => setActiveLayerId(layer.id)} className={`flex-1 text-left text-xs truncate ${activeLayerId === layer.id ? 'text-emerald-400 font-medium' : 'theme-text-primary'}`}>{layer.name}</button>
                                                    <span className="text-[10px] theme-text-muted">{layer.features.length}</span>
                                                    {project.layers.length > 1 && <button onClick={() => deleteLayer(layer.id)} className="p-0.5 text-red-400/50 hover:text-red-400"><Trash2 size={10} /></button>}
                                                </div>
                                                {activeLayerId === layer.id && (
                                                    <div className="mt-1.5 space-y-0.5 max-h-40 overflow-y-auto">
                                                        {project.features.filter(f => f.layerId === layer.id).map(f => (
                                                            <button key={f.id} onClick={() => { setSelectedFeatureId(f.id); setSidebarTab('properties'); if (f.type === 'marker' && mapRef.current) mapRef.current.setView(f.coordinates as [number, number], mapRef.current.getZoom()); }}
                                                                className={`w-full text-left px-1.5 py-1 rounded text-[11px] flex items-center gap-1.5 ${selectedFeatureId === f.id ? 'bg-emerald-600/30 text-emerald-300' : 'theme-text-muted hover:theme-bg-tertiary'}`}>
                                                                {f.type === 'marker' ? <MapPin size={10} /> : f.type === 'line' ? <Route size={10} /> : f.type === 'polygon' ? <Hexagon size={10} /> : <Circle size={10} />}
                                                                <span className="truncate">{f.name}</span>
                                                            </button>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {sidebarTab === 'properties' && selectedFeature && (
                                    <div className="space-y-3">
                                        <div>
                                            <label className="text-[10px] theme-text-muted block mb-1">Name</label>
                                            {editingFeatureName === selectedFeature.id ? (
                                                <div className="flex gap-1">
                                                    <input type="text" value={editNameValue} onChange={(e) => setEditNameValue(e.target.value)}
                                                        onKeyDown={(e) => { if (e.key === 'Enter') { updateFeature(selectedFeature.id, { name: editNameValue }); setEditingFeatureName(null); } if (e.key === 'Escape') setEditingFeatureName(null); }}
                                                        className="flex-1 px-1.5 py-0.5 text-xs theme-bg-tertiary theme-text-primary border theme-border rounded focus:outline-none" autoFocus />
                                                    <button onClick={() => { updateFeature(selectedFeature.id, { name: editNameValue }); setEditingFeatureName(null); }} className="text-xs text-emerald-400">OK</button>
                                                </div>
                                            ) : (
                                                <button onClick={() => { setEditingFeatureName(selectedFeature.id); setEditNameValue(selectedFeature.name); }} className="text-sm theme-text-primary hover:text-emerald-400 text-left w-full truncate">{selectedFeature.name}</button>
                                            )}
                                        </div>
                                        <div><label className="text-[10px] theme-text-muted block mb-1">Type</label><span className="text-xs theme-text-primary capitalize">{selectedFeature.type}</span></div>
                                        <div>
                                            <label className="text-[10px] theme-text-muted block mb-1">Color</label>
                                            <div className="flex gap-1 flex-wrap">{LAYER_COLORS.map(c => (<button key={c} onClick={() => updateFeature(selectedFeature.id, { color: c })} className={`w-5 h-5 rounded ${selectedFeature.color === c ? 'ring-2 ring-white' : ''}`} style={{ backgroundColor: c }} />))}</div>
                                        </div>
                                        {selectedFeature.type === 'marker' && (
                                            <div><label className="text-[10px] theme-text-muted block mb-1">Coordinates</label><span className="text-xs theme-text-primary font-mono">{(selectedFeature.coordinates as [number, number])[0].toFixed(6)}, {(selectedFeature.coordinates as [number, number])[1].toFixed(6)}</span></div>
                                        )}
                                        {Object.keys(selectedFeature.properties).filter(k => !k.startsWith('_')).length > 0 && (
                                            <div>
                                                <label className="text-[10px] theme-text-muted block mb-1">Properties</label>
                                                <div className="space-y-0.5 max-h-32 overflow-y-auto">
                                                    {Object.entries(selectedFeature.properties).filter(([k]) => !k.startsWith('_')).map(([k, v]) => (
                                                        <div key={k} className="flex text-[11px]"><span className="theme-text-muted w-20 truncate flex-shrink-0">{k}:</span><span className="theme-text-primary truncate">{String(v)}</span></div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                        <div className="pt-2 border-t theme-border flex gap-1">
                                            <button onClick={() => navigator.clipboard.writeText(JSON.stringify(featuresToGeoJSON([selectedFeature]), null, 2))}
                                                className="flex-1 px-2 py-1 text-xs theme-bg-tertiary theme-text-primary rounded hover:theme-bg-primary flex items-center justify-center gap-1"><Copy size={10} /> GeoJSON</button>
                                            <button onClick={() => deleteFeature(selectedFeature.id)} className="px-2 py-1 text-xs bg-red-600/20 text-red-400 rounded hover:bg-red-600/30"><Trash2 size={10} /></button>
                                        </div>
                                    </div>
                                )}
                                {sidebarTab === 'properties' && !selectedFeature && (
                                    <div className="text-xs theme-text-muted text-center mt-8"><Navigation size={24} className="mx-auto mb-2 opacity-50" /><p>Select a feature</p></div>
                                )}

                                {sidebarTab === 'overlays' && (
                                    <div className="space-y-3">
                                        <p className="text-[10px] theme-text-muted">Toggle tile overlays and reference layers.</p>

                                        {/* Tile overlays */}
                                        <div>
                                            <span className="text-[10px] theme-text-muted uppercase tracking-wider font-medium">tile overlays</span>
                                            <div className="mt-1 space-y-0.5">
                                                {Object.entries(TILE_OVERLAYS).map(([key, overlay]) => (
                                                    <label key={key} className="flex items-center gap-2 px-1.5 py-1 rounded hover:theme-bg-tertiary cursor-pointer text-xs">
                                                        <input type="checkbox" checked={activeTileOverlays.has(key)}
                                                            onChange={() => setActiveTileOverlays(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; })}
                                                            className="accent-emerald-500" />
                                                        <span className="theme-text-primary">{overlay.name}</span>
                                                    </label>
                                                ))}
                                            </div>
                                        </div>
                                        {Object.entries(
                                            Object.entries(REFERENCE_LAYERS).reduce((acc, [k, v]) => {
                                                (acc[v.category] = acc[v.category] || []).push([k, v]);
                                                return acc;
                                            }, {} as Record<string, [string, any][]>)
                                        ).map(([category, layers]) => (
                                            <div key={category}>
                                                <span className="text-[10px] theme-text-muted uppercase tracking-wider font-medium">{category}</span>
                                                <div className="mt-1 space-y-0.5">
                                                    {layers.map(([key, layer]: [string, any]) => (
                                                        <label key={key} className="flex items-center gap-2 px-1.5 py-1 rounded hover:theme-bg-tertiary cursor-pointer text-xs">
                                                            <input
                                                                type="checkbox"
                                                                checked={activeOverlays.has(key)}
                                                                onChange={() => setActiveOverlays(prev => {
                                                                    const next = new Set(prev);
                                                                    if (next.has(key)) next.delete(key); else next.add(key);
                                                                    return next;
                                                                })}
                                                                className="accent-emerald-500"
                                                            />
                                                            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: layer.style?.color || layer.style?.fillColor || '#666' }} />
                                                            <span className="theme-text-primary">{layer.name}</span>
                                                        </label>
                                                    ))}
                                                </div>
                                            </div>
                                        ))}
                                        {activeOverlays.size > 0 && (
                                            <button onClick={() => { setActiveOverlays(new Set()); setActiveTileOverlays(new Set()); }} className="text-[10px] text-red-400 hover:text-red-300">Clear all overlays</button>
                                        )}
                                    </div>
                                )}

                                {sidebarTab === 'weather' && (
                                    <div className="space-y-3">
                                        <p className="text-[10px] theme-text-muted">Live NOAA forecast overlays and fetchable weather geography. Set forecast time for future products.</p>

                                        {/* Forecast time slider */}
                                        <div>
                                            <div className="flex items-center justify-between mb-1">
                                                <span className="text-[10px] theme-text-muted uppercase tracking-wider font-medium">Forecast time</span>
                                                <span className="text-[10px] text-emerald-400 font-mono">T+{forecastHour}h</span>
                                            </div>
                                            <input
                                                type="range" min={0} max={18} step={1} value={forecastHour}
                                                onChange={(e) => setForecastHour(parseInt(e.target.value, 10))}
                                                className="w-full accent-emerald-500"
                                            />
                                            <div className="flex justify-between text-[9px] theme-text-muted mt-0.5">
                                                <span>Now</span>
                                                <span>+6h</span>
                                                <span>+12h</span>
                                                <span>+18h</span>
                                            </div>
                                        </div>

                                        {/* NOAA nowCOAST WMS overlays */}
                                        <div>
                                            <span className="text-[10px] theme-text-muted uppercase tracking-wider font-medium">Weather overlays</span>
                                            <div className="mt-1 space-y-0.5">
                                                {Object.entries(WEATHER_LAYERS).map(([key, layer]) => (
                                                    <label key={key} className="flex items-center gap-2 px-1.5 py-1 rounded hover:theme-bg-tertiary cursor-pointer text-xs">
                                                        <input
                                                            type="checkbox"
                                                            checked={activeWeatherLayers.has(key)}
                                                            onChange={() => setActiveWeatherLayers(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; })}
                                                            className="accent-emerald-500"
                                                        />
                                                        <span className="theme-text-primary">{layer.name}</span>
                                                        {layer.forecastable && <span className="text-[9px] theme-text-muted">time-aware</span>}
                                                    </label>
                                                ))}
                                            </div>
                                        </div>

                                        {/* Fetchable weather vector layers */}
                                        <div>
                                            <span className="text-[10px] theme-text-muted uppercase tracking-wider font-medium">Add to GIS layer</span>
                                            <div className="mt-1 space-y-0.5">
                                                {['nws_alerts', 'wpc_surface', 'nhc_storms'].map(key => {
                                                    const preset = OSINT_PRESETS[key];
                                                    return (
                                                        <div key={key} className="flex items-center gap-2 px-1.5 py-1 rounded hover:theme-bg-tertiary text-xs group">
                                                            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: preset.color }} />
                                                            <span className="theme-text-primary flex-1">{preset.label}</span>
                                                            <button
                                                                onClick={() => fetchOsintCategory(key)}
                                                                disabled={osintLoading.has(key)}
                                                                className="text-[10px] px-1.5 py-0.5 bg-emerald-600/20 text-emerald-400 rounded hover:bg-emerald-600/30 disabled:opacity-50"
                                                            >
                                                                {osintLoading.has(key) ? '...' : 'Fetch'}
                                                            </button>
                                                            {osintCache[key] && (
                                                                <button
                                                                    onClick={() => osintCache[key].results.forEach(addOsintResult)}
                                                                    className="opacity-0 group-hover:opacity-100 p-0.5 theme-text-muted hover:text-emerald-400 transition-opacity"
                                                                    title="Add all to active layer"
                                                                >
                                                                    <Plus size={10} />
                                                                </button>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>

                                        {activeWeatherLayers.size > 0 && (
                                            <button onClick={() => { setActiveWeatherLayers(new Set()); setForecastHour(0); }} className="text-[10px] text-red-400 hover:text-red-300">Clear weather overlays</button>
                                        )}
                                    </div>
                                )}

                                {sidebarTab === 'osint' && (
                                    <div className="space-y-3">
                                        <p className="text-[10px] theme-text-muted">Toggle OSM data layers for current viewport. Auto-refreshes when you pan.</p>

                                        {/* OSINT toggleable layers by category */}
                                        {Object.entries(
                                            Object.entries(OSINT_PRESETS).reduce((acc, [k, v]) => {
                                                (acc[v.category] = acc[v.category] || []).push([k, v]);
                                                return acc;
                                            }, {} as Record<string, [string, any][]>)
                                        ).map(([category, items]) => (
                                            <div key={category}>
                                                <span className="text-[10px] theme-text-muted uppercase tracking-wider font-medium">{category}</span>
                                                <div className="mt-1 space-y-0.5">
                                                    {items.map(([key, preset]: [string, any]) => (
                                                        <label key={key} className="flex items-center gap-2 px-1.5 py-1 rounded hover:theme-bg-tertiary cursor-pointer text-xs group">
                                                            <input type="checkbox" checked={osintVisible.has(key)} onChange={() => toggleOsintLayer(key)} className="accent-emerald-500" />
                                                            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: preset.color }} />
                                                            <span className="theme-text-primary flex-1">{preset.label}</span>
                                                            {osintLoading.has(key) && <span className="text-[9px] text-emerald-400 animate-pulse">loading</span>}
                                                            {osintCache[key] && <span className="text-[9px] theme-text-muted">{osintCache[key].results.length}</span>}
                                                            {osintCache[key] && (
                                                                <button
                                                                    onClick={(e) => { e.preventDefault(); osintCache[key].results.forEach(addOsintResult); }}
                                                                    className="opacity-0 group-hover:opacity-100 p-0.5 theme-text-muted hover:text-emerald-400 transition-opacity"
                                                                    title={`Add all ${preset.geomType || 'points'} to active layer`}
                                                                >
                                                                    <Plus size={10} />
                                                                </button>
                                                            )}
                                                        </label>
                                                    ))}
                                                </div>
                                            </div>
                                        ))}

                                        {osintVisible.size > 0 && (
                                            <button onClick={() => { setOsintVisible(new Set()); }} className="text-[10px] text-red-400 hover:text-red-300">Clear all OSINT layers</button>
                                        )}

                                        <div className="border-t theme-border pt-2">
                                            <label className="text-[10px] theme-text-muted block mb-1">Custom Overpass query</label>
                                            <div className="flex gap-1">
                                                <input type="text" value={osintQuery} onChange={(e) => setOsintQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && fetchOSINT()}
                                                    placeholder="amenity=hospital"
                                                    className="flex-1 px-2 py-1 text-xs theme-bg-tertiary theme-text-primary border theme-border rounded focus:outline-none focus:border-emerald-500" />
                                                <button onClick={() => fetchOSINT()} disabled={isOsintLoading} className="px-2 py-1 text-xs bg-emerald-600 text-white rounded disabled:opacity-50">{isOsintLoading ? '...' : 'Fetch'}</button>
                                            </div>
                                        </div>
                                        {osintResults.length > 0 && (
                                            <div>
                                                <div className="flex items-center justify-between mb-1">
                                                    <span className="text-[10px] theme-text-muted">{osintResults.length} results</span>
                                                    <button onClick={() => osintResults.forEach(r => addOsintResult(r))} className="text-[10px] text-emerald-400">Add all</button>
                                                </div>
                                                <div className="space-y-1 max-h-60 overflow-y-auto">
                                                    {osintResults.map((r: any, i: number) => (
                                                        <div key={i} className="flex items-start gap-1.5 p-1.5 theme-bg-tertiary rounded text-[11px]">
                                                            <div className="flex-1 min-w-0">
                                                                <p className="theme-text-primary truncate font-medium">{r.name}</p>
                                                                <p className="theme-text-muted truncate">{r.category} &middot; {r.lat?.toFixed(4)}, {r.lng?.toFixed(4)}</p>
                                                            </div>
                                                            <button onClick={() => { if (r.lat && r.lng) mapRef.current?.setView([r.lat, r.lng], 16); }} className="p-1 theme-text-muted hover:text-emerald-400" title="Go to"><LocateFixed size={10} /></button>
                                                            <button onClick={() => addOsintResult(r)} className="p-1 theme-text-muted hover:text-emerald-400" title="Add"><Plus size={10} /></button>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Sidebar toggle */}
                    <button onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                        className="w-4 flex-shrink-0 flex items-center justify-center theme-bg-secondary border-r theme-border hover:theme-bg-tertiary">
                        {sidebarCollapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} className="rotate-90" />}
                    </button>

                    {/* Map */}
                    <div className="relative flex-1">
                        <GISMapView
                            project={project}
                            onProjectChange={updateProject}
                            mode={mode}
                            onModeChange={setMode}
                            selectedFeatureId={selectedFeatureId}
                            onSelectFeature={setSelectedFeatureId}
                            mapRef={mapRef}
                            className="absolute inset-0 w-full h-full"
                            activeOverlays={activeOverlays}
                            activeTileOverlays={activeTileOverlays}
                            osintLayers={Array.from(osintVisible).filter(k => osintCache[k]).map(k => ({
                                key: k,
                                color: OSINT_PRESETS[k]?.color || '#f59e0b',
                                markers: osintCache[k].results,
                            }))}
                        />

                    </div>
                </div>
            )}

            {activeTab === 'globe' && (
                <div className="flex-1 w-full min-w-0 overflow-hidden relative">
                    <EarthView className="w-full min-w-0" />
                </div>
            )}
        </div>
    );
};

const arePropsEqual = (prevProps: any, nextProps: any) => prevProps.filePath === nextProps.filePath;
export default memo(Tezcat, arePropsEqual);
