import { useState } from "react";
import {
  MapContainer,
  TileLayer,
  Polygon,
  Polyline,
  useMapEvents,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import "./App.css";

const DEFAULT_CENTER = [37.45, 127.13];
const DEFAULT_ZOOM = 18;

const OVERPASS_ENDPOINTS = [
  "/api/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

function getArea(coords) {
  if (!coords || coords.length < 3) return 0;

  const lat0 = coords.reduce((sum, [lat]) => sum + lat, 0) / coords.length;
  const metersPerDegLat = 111320;
  const metersPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);

  const pts = coords.map(([lat, lng]) => [
    lng * metersPerDegLng,
    lat * metersPerDegLat,
  ]);

  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    area += x1 * y2 - x2 * y1;
  }

  return Math.abs(area) / 2;
}

function getCentroid(coords) {
  const lat = coords.reduce((sum, [cLat]) => sum + cLat, 0) / coords.length;
  const lng = coords.reduce((sum, [, cLng]) => sum + cLng, 0) / coords.length;
  return [lat, lng];
}

function getDistanceSquared(aLat, aLng, bLat, bLng) {
  const dLat = aLat - bLat;
  const dLng = aLng - bLng;
  return dLat * dLat + dLng * dLng;
}

function formatNumber(value, digits = 0) {
  return new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

function estimateSolar(area) {
  const usableArea = area * 0.72;
  const capacityKw = usableArea / 5.5;
  const annualGeneration = capacityKw * 1250 * 0.86;

  return {
    roofArea: area,
    usableArea,
    capacityKw,
    annualGeneration,
  };
}

async function fetchOverpassWithFallback(query) {
  let lastError = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        body: query,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} @ ${endpoint}`);
      }

      return await response.json();
    } catch (error) {
      console.error("Overpass 실패:", endpoint, error);
      lastError = error;
    }
  }

  throw lastError || new Error("모든 Overpass 서버 요청 실패");
}

function MapWatcher({ onViewportChange, onMapClick, disabled }) {
  useMapEvents({
    moveend(e) {
      const map = e.target;
      const center = map.getCenter();
      const bounds = map.getBounds();

      onViewportChange({
        center: [center.lat, center.lng],
        zoom: map.getZoom(),
        bounds: {
          south: bounds.getSouth(),
          west: bounds.getWest(),
          north: bounds.getNorth(),
          east: bounds.getEast(),
        },
      });
    },
    zoomend(e) {
      const map = e.target;
      const center = map.getCenter();
      const bounds = map.getBounds();

      onViewportChange({
        center: [center.lat, center.lng],
        zoom: map.getZoom(),
        bounds: {
          south: bounds.getSouth(),
          west: bounds.getWest(),
          north: bounds.getNorth(),
          east: bounds.getEast(),
        },
      });
    },
    click(e) {
      if (disabled) return;
      onMapClick(e.latlng.lat, e.latlng.lng);
    },
  });

  return null;
}

export default function App() {
  const [mode, setMode] = useState("auto");
  const [viewport, setViewport] = useState({
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    bounds: null,
  });

  const [selectedBuilding, setSelectedBuilding] = useState(null);
  const [drawPoints, setDrawPoints] = useState([]);
  const [isLoadingBuilding, setIsLoadingBuilding] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [status, setStatus] = useState(
    "모드를 고른 뒤 지도를 이동해서 건물을 선택하세요."
  );

  async function loadNearestBuilding(lat, lng) {
    if (mode !== "auto") return;
    if (isLoadingBuilding) return;

    if (cooldown) {
      setStatus("잠깐만 기다려... 3초 뒤 다시 시도해줘");
      return;
    }

    if (viewport.zoom < 18) {
      setStatus("자동 선택은 더 확대한 뒤 건물 중앙을 클릭해야 해. 권장 줌은 18 이상이야.");
      return;
    }

    setIsLoadingBuilding(true);
    setStatus("클릭한 위치 근처의 건물을 찾는 중입니다...");
    setDrawPoints([]);

    try {
      const overpassQuery = `
        [out:json][timeout:8];
        (
          way["building"](around:15,${lat},${lng});
        );
        out tags geom;
      `;

      const payload = await fetchOverpassWithFallback(overpassQuery);

      const candidates = (payload.elements || [])
        .filter((el) => Array.isArray(el.geometry) && el.geometry.length >= 3)
        .map((el) => {
          const coords = el.geometry.map((point) => [point.lat, point.lon]);
          const area = getArea(coords);
          const [cLat, cLng] = getCentroid(coords);

          return {
            id: el.id,
            name: el.tags?.name || el.tags?.building || `건물 ${el.id}`,
            levels: el.tags?.["building:levels"] || "정보 없음",
            type: el.tags?.building || "building",
            coords,
            area,
            distanceScore: getDistanceSquared(lat, lng, cLat, cLng),
            source: "auto",
          };
        })
        .filter((building) => building.area >= 15)
        .sort((a, b) => a.distanceScore - b.distanceScore);

      if (!candidates.length) {
        setStatus("이 위치 근처에서 건물을 찾지 못했습니다. 건물 중앙을 다시 클릭해 보세요.");
        return;
      }

      setSelectedBuilding(candidates[0]);
      setStatus("자동 선택으로 건물 1개를 찾았습니다.");
    } catch (error) {
      console.error(error);
      setStatus("건물 서버가 바쁘거나 응답이 느립니다. 잠시 후 다시 시도하세요.");
    } finally {
      setIsLoadingBuilding(false);
      setCooldown(true);
      setTimeout(() => setCooldown(false), 3000);
    }
  }

  function handleDrawPoint(lat, lng) {
    if (mode !== "draw") return;
    setSelectedBuilding(null);

    setDrawPoints((prev) => {
      if (prev.length >= 8) {
        setStatus("점은 최대 8개까지 찍을 수 있어. 필요하면 초기화하고 다시 그려줘.");
        return prev;
      }
      const next = [...prev, [lat, lng]];
      setStatus(`점 ${next.length}개를 찍었어. 3개 이상이면 폴리곤 계산 가능.`);
      return next;
    });
  }

  function handleMapClick(lat, lng) {
    if (mode === "auto") {
      loadNearestBuilding(lat, lng);
    } else {
      handleDrawPoint(lat, lng);
    }
  }

  function clearDrawing() {
    setDrawPoints([]);
    setSelectedBuilding(null);
    setStatus("직접 그리기 점을 초기화했어.");
  }

  function completeDrawing() {
    if (drawPoints.length < 3) {
      setStatus("직접 그리기는 점 3개 이상이 필요해.");
      return;
    }

    const area = getArea(drawPoints);

    setSelectedBuilding({
      id: "manual-drawing",
      name: "직접 그린 건물",
      levels: "직접 지정 안 함",
      type: "manual",
      coords: drawPoints,
      area,
      source: "manual",
    });

    setStatus("직접 그린 건물 폴리곤을 계산했어.");
  }

  const estimate = selectedBuilding ? estimateSolar(selectedBuilding.area) : null;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <p className="eyebrow">SMART SOLAR 2</p>
        <h1>건물 선택 태양광 지도</h1>
        <p className="lead">
          자동 선택과 직접 그리기 두 가지 방식으로 건물을 지정할 수 있어.
        </p>

        <div className="panel">
          <h2>모드 선택</h2>
          <div className="mode-row">
            <button
              onClick={() => {
                setMode("auto");
                setDrawPoints([]);
                setSelectedBuilding(null);
                setStatus("자동 선택 모드야. 건물 중앙을 클릭해.");
              }}
            >
              자동 선택
            </button>
            <button
              className="ghost-button"
              onClick={() => {
                setMode("draw");
                setDrawPoints([]);
                setSelectedBuilding(null);
                setStatus("직접 그리기 모드야. 건물 꼭짓점을 순서대로 클릭해.");
              }}
            >
              직접 그리기
            </button>
          </div>
          <p className="helper-text">
            자동 선택은 편하지만 서버가 불안정할 수 있고, 직접 그리기는 가장 안정적이야.
          </p>
        </div>

        <div className="panel">
          <h2>현재 상태</h2>
          <dl className="metric-list single-column">
            <div>
              <dt>현재 모드</dt>
              <dd>{mode === "auto" ? "자동 선택" : "직접 그리기"}</dd>
            </div>
            <div>
              <dt>현재 중심</dt>
              <dd>
                {viewport.center[0].toFixed(4)}, {viewport.center[1].toFixed(4)}
              </dd>
            </div>
            <div>
              <dt>현재 줌</dt>
              <dd>{viewport.zoom}</dd>
            </div>
            {mode === "draw" && (
              <div>
                <dt>찍은 점 개수</dt>
                <dd>{drawPoints.length}</dd>
              </div>
            )}
          </dl>
          <p className="status-text">{status}</p>

          {mode === "draw" && (
            <div className="action-row">
              <button onClick={completeDrawing}>폴리곤 완성</button>
              <button className="ghost-button" onClick={clearDrawing}>
                초기화
              </button>
            </div>
          )}
        </div>

        <div className="panel result-panel">
          <h2>{selectedBuilding ? selectedBuilding.name : "건물을 선택하세요"}</h2>

          {!selectedBuilding && (
            <p className="empty-text">
              자동 선택에서는 건물 중앙 클릭, 직접 그리기에서는 점을 3개 이상 찍은 뒤 폴리곤 완성을 누르면 돼.
            </p>
          )}

          {selectedBuilding && estimate && (
            <dl className="metric-list single-column">
              <div>
                <dt>선택 방식</dt>
                <dd>{selectedBuilding.source === "auto" ? "자동 선택" : "직접 그리기"}</dd>
              </div>
              <div>
                <dt>건물 유형</dt>
                <dd>{selectedBuilding.type}</dd>
              </div>
              <div>
                <dt>층수</dt>
                <dd>{selectedBuilding.levels}</dd>
              </div>
              <div>
                <dt>건물 면적</dt>
                <dd>{formatNumber(estimate.roofArea)} ㎡</dd>
              </div>
              <div>
                <dt>설치 가능 면적</dt>
                <dd>{formatNumber(estimate.usableArea)} ㎡</dd>
              </div>
              <div>
                <dt>예상 설비 용량</dt>
                <dd>{formatNumber(estimate.capacityKw, 1)} kW</dd>
              </div>
              <div>
                <dt>연간 예상 발전량</dt>
                <dd>{formatNumber(estimate.annualGeneration)} kWh</dd>
              </div>
            </dl>
          )}
        </div>
      </aside>

      <main className="map-stage">
        {isLoadingBuilding && (
          <div className="loading-chip">건물 찾는 중...</div>
        )}

        <MapContainer
          center={DEFAULT_CENTER}
          zoom={DEFAULT_ZOOM}
          maxZoom={20}
          className="map-canvas"
        >
          <TileLayer
            attribution="&copy; OpenStreetMap contributors"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            maxZoom={20}
          />

          <MapWatcher
            onViewportChange={setViewport}
            onMapClick={handleMapClick}
            disabled={isLoadingBuilding}
          />

          {mode === "draw" && drawPoints.length > 0 && (
            <>
              <Polyline positions={drawPoints} pathOptions={{ color: "#2563eb", weight: 3 }} />
              {drawPoints.length >= 3 && (
                <Polygon
                  positions={drawPoints}
                  pathOptions={{
                    color: "#2563eb",
                    weight: 2,
                    fillColor: "#60a5fa",
                    fillOpacity: 0.25,
                  }}
                />
              )}
            </>
          )}

          {selectedBuilding && (
            <Polygon
              positions={selectedBuilding.coords}
              pathOptions={{
                color: "#f97316",
                weight: 3,
                fillColor: "#fb923c",
                fillOpacity: 0.45,
              }}
            />
          )}
        </MapContainer>
      </main>
    </div>
  );
}