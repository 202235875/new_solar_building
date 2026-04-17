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
const USABLE_RATIO = 0.55;

/*
  아래 두 값은 사용자가 쉽게 바꿀 수 있게 둔 가정값이다.
  - 전기요금 단가: 절감액 계산용
  - 전력 배출계수: 탄소 절감량 계산용
*/
const DEFAULT_ELECTRICITY_PRICE_KRW_PER_KWH = 120;
const DEFAULT_GRID_EMISSION_KGCO2_PER_KWH = 0.45;

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
  for (let i = 0; i < pts.length; i += 1) {
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

function formatNumber(value, digits = 0) {
  return new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

function estimateSimpleSolar(area) {
  const usableArea = area * USABLE_RATIO;
  const capacityKw = usableArea / 5.5;
  const annualGeneration = capacityKw * 1250 * 0.86;

  return {
    roofArea: area,
    usableArea,
    capacityKw,
    annualGeneration,
  };
}

function addEconomicAndCarbonMetrics(result) {
  const annualSavingsKRW =
    result.annualGenerationKWh * DEFAULT_ELECTRICITY_PRICE_KRW_PER_KWH;
  const monthlySavingsKRW = annualSavingsKRW / 12;

  const annualCarbonReductionKg =
    result.annualGenerationKWh * DEFAULT_GRID_EMISSION_KGCO2_PER_KWH;
  const annualCarbonReductionTon = annualCarbonReductionKg / 1000;

  return {
    ...result,
    annualSavingsKRW,
    monthlySavingsKRW,
    annualCarbonReductionKg,
    annualCarbonReductionTon,
  };
}

async function fetchSolarWeatherByYear({
  latitude,
  longitude,
  year,
  tilt = 30,
  azimuth = 0,
}) {
  const url =
    `https://archive-api.open-meteo.com/v1/archive` +
    `?latitude=${latitude}` +
    `&longitude=${longitude}` +
    `&start_date=${year}-01-01` +
    `&end_date=${year}-12-31` +
    `&hourly=global_tilted_irradiance,temperature_2m` +
    `&tilt=${tilt}` +
    `&azimuth=${azimuth}` +
    `&timezone=Asia%2FSeoul`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${year}년 기상 데이터를 불러오지 못했습니다.`);
  }

  return await response.json();
}

function calculateSolarFromWeather({
  areaM2,
  weatherData,
  panelEfficiency = 0.2,
  performanceRatio = 0.86,
  tempCoeff = 0.004,
  usableRatio = USABLE_RATIO,
}) {
  const irradiation = weatherData?.hourly?.global_tilted_irradiance ?? [];
  const temperature = weatherData?.hourly?.temperature_2m ?? [];

  const usableArea = areaM2 * usableRatio;

  let annualGenerationKWh = 0;

  for (let i = 0; i < irradiation.length; i += 1) {
    const gti = irradiation[i] ?? 0;
    const temp = temperature[i] ?? 25;
    const tempFactor = Math.max(0, 1 - tempCoeff * (temp - 25));

    const hourlyKWh =
      (gti * usableArea * panelEfficiency * performanceRatio * tempFactor) /
      1000;

    annualGenerationKWh += hourlyKWh;
  }

  const installedCapacityKw = usableArea / 5.5;
  const specificYield =
    installedCapacityKw > 0
      ? annualGenerationKWh / installedCapacityKw
      : 0;

  return {
    usableArea,
    installedCapacityKw,
    annualGenerationKWh,
    monthlyAverageKWh: annualGenerationKWh / 12,
    specificYield,
  };
}

function MapWatcher({ onViewportChange, onMapClick }) {
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
      onMapClick(e.latlng.lat, e.latlng.lng);
    },
  });

  return null;
}

export default function App() {
  const [viewport, setViewport] = useState({
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    bounds: null,
  });

  const [drawPoints, setDrawPoints] = useState([]);
  const [selectedBuilding, setSelectedBuilding] = useState(null);
  const [status, setStatus] = useState(
    "건물 꼭짓점을 순서대로 클릭하세요. 점 3개 이상이면 폴리곤 완성이 가능합니다."
  );

  const [multiYearResult, setMultiYearResult] = useState(null);
  const [isLoadingWeather, setIsLoadingWeather] = useState(false);

  function handleMapClick(lat, lng) {
    setSelectedBuilding(null);
    setMultiYearResult(null);

    setDrawPoints((prev) => {
      const next = [...prev, [lat, lng]];
      setStatus(
        `점 ${next.length}개를 찍었습니다. 3개 이상이면 폴리곤 완성이 가능합니다.`
      );
      return next;
    });
  }

  function clearDrawing() {
    setDrawPoints([]);
    setSelectedBuilding(null);
    setMultiYearResult(null);
    setStatus("초기화했습니다. 다시 건물 꼭짓점을 클릭하세요.");
  }

  function undoLastPoint() {
    setDrawPoints((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.slice(0, -1);
      setStatus(
        `마지막 점을 지웠습니다. 현재 ${next.length}개 점이 남아 있습니다.`
      );
      return next;
    });
    setSelectedBuilding(null);
    setMultiYearResult(null);
  }

  function completeDrawing() {
    if (drawPoints.length < 3) {
      setStatus("점 3개 이상이 필요합니다.");
      return;
    }

    const area = getArea(drawPoints);

    setSelectedBuilding({
      id: "manual-drawing",
      name: "직접 그린 건물",
      coords: drawPoints,
      area,
      source: "manual",
    });

    setMultiYearResult(null);
    setStatus(
      "폴리곤 계산이 완료되었습니다. 이제 3개년 평균 + PR 시나리오 계산을 실행할 수 있습니다."
    );
  }

  async function analyzeWithMultiYearWeather() {
    if (!selectedBuilding) {
      setStatus("먼저 폴리곤을 완성하세요.");
      return;
    }

    setIsLoadingWeather(true);
    setStatus("2023~2025년 실제 날씨 데이터와 PR 시나리오를 계산하는 중입니다...");

    try {
      const [lat, lng] = getCentroid(selectedBuilding.coords);

      const years = [2023, 2024, 2025];
      const prScenarios = [
        { label: "보수적", value: 0.75 },
        { label: "기준", value: 0.8 },
        { label: "낙관적", value: 0.86 },
      ];

      const weatherByYear = {};
      for (const year of years) {
        weatherByYear[year] = await fetchSolarWeatherByYear({
          latitude: lat,
          longitude: lng,
          year,
          tilt: 30,
          azimuth: 0,
        });
      }

      const scenarioResults = prScenarios.map((scenario) => {
        const yearly = years.map((year) => {
          const result = calculateSolarFromWeather({
            areaM2: selectedBuilding.area,
            weatherData: weatherByYear[year],
            panelEfficiency: 0.2,
            performanceRatio: scenario.value,
            tempCoeff: 0.004,
            usableRatio: USABLE_RATIO,
          });

          return addEconomicAndCarbonMetrics({
            year,
            annualGenerationKWh: result.annualGenerationKWh,
            monthlyAverageKWh: result.monthlyAverageKWh,
            specificYield: result.specificYield,
            installedCapacityKw: result.installedCapacityKw,
            usableArea: result.usableArea,
          });
        });

        const avgAnnualGenerationKWh =
          yearly.reduce((sum, item) => sum + item.annualGenerationKWh, 0) /
          yearly.length;

        const avgMonthlyGenerationKWh =
          yearly.reduce((sum, item) => sum + item.monthlyAverageKWh, 0) /
          yearly.length;

        const avgSpecificYield =
          yearly.reduce((sum, item) => sum + item.specificYield, 0) /
          yearly.length;

        const avgAnnualSavingsKRW =
          yearly.reduce((sum, item) => sum + item.annualSavingsKRW, 0) /
          yearly.length;

        const avgMonthlySavingsKRW =
          yearly.reduce((sum, item) => sum + item.monthlySavingsKRW, 0) /
          yearly.length;

        const avgAnnualCarbonReductionTon =
          yearly.reduce((sum, item) => sum + item.annualCarbonReductionTon, 0) /
          yearly.length;

        return {
          label: scenario.label,
          pr: scenario.value,
          yearly,
          avgAnnualGenerationKWh,
          avgMonthlyGenerationKWh,
          avgSpecificYield,
          avgAnnualSavingsKRW,
          avgMonthlySavingsKRW,
          avgAnnualCarbonReductionTon,
          installedCapacityKw: yearly[0].installedCapacityKw,
          usableArea: yearly[0].usableArea,
        };
      });

      setMultiYearResult({
        years,
        scenarios: scenarioResults,
      });

      setStatus("2023~2025년 3개년 평균 및 PR 시나리오 계산이 완료되었습니다.");
    } catch (error) {
      console.error(error);
      setStatus("3개년 날씨 기반 계산에 실패했습니다.");
    } finally {
      setIsLoadingWeather(false);
    }
  }

  function openResultWindow() {
    if (!selectedBuilding) {
      setStatus("먼저 폴리곤을 완성하세요.");
      return;
    }

    const popup = window.open("", "_blank", "width=1280,height=920");
    if (!popup) {
      setStatus("팝업이 차단되었습니다. 브라우저에서 팝업을 허용해 주세요.");
      return;
    }

    const simple = addEconomicAndCarbonMetrics({
      ...estimateSimpleSolar(selectedBuilding.area),
      annualGenerationKWh: estimateSimpleSolar(selectedBuilding.area).annualGeneration,
    });

    const polygonCoordsText = JSON.stringify(selectedBuilding.coords);

    const scenarioHtml = multiYearResult
      ? multiYearResult.scenarios
          .map((scenario) => {
            const yearlyRows = scenario.yearly
              .map(
                (item) => `
                  <tr>
                    <td>${item.year}년</td>
                    <td>${formatNumber(item.annualGenerationKWh)} kWh</td>
                    <td>${formatNumber(item.annualSavingsKRW)} 원</td>
                    <td>${formatNumber(item.annualCarbonReductionTon, 2)} tCO₂</td>
                  </tr>
                `
              )
              .join("");

            return `
              <section class="scenario-card">
                <div class="scenario-label">${scenario.label} 시나리오 · PR ${scenario.pr}</div>

                <div class="grid">
                  <div class="card">
                    <div class="label">설치 가능 면적</div>
                    <div class="value">${formatNumber(scenario.usableArea)} ㎡</div>
                  </div>
                  <div class="card">
                    <div class="label">예상 설비 용량</div>
                    <div class="value">${formatNumber(scenario.installedCapacityKw, 1)} kW</div>
                  </div>
                  <div class="card">
                    <div class="label">3개년 평균 연간 발전량</div>
                    <div class="value">${formatNumber(scenario.avgAnnualGenerationKWh)} kWh</div>
                  </div>
                  <div class="card">
                    <div class="label">3개년 평균 월평균 발전량</div>
                    <div class="value">${formatNumber(scenario.avgMonthlyGenerationKWh)} kWh</div>
                  </div>
                  <div class="card">
                    <div class="label">3개년 평균 연간 절감액</div>
                    <div class="value">${formatNumber(scenario.avgAnnualSavingsKRW)} 원</div>
                  </div>
                  <div class="card">
                    <div class="label">3개년 평균 월 절감액</div>
                    <div class="value">${formatNumber(scenario.avgMonthlySavingsKRW)} 원</div>
                  </div>
                  <div class="card">
                    <div class="label">3개년 평균 특정수율</div>
                    <div class="value">${formatNumber(scenario.avgSpecificYield, 1)} kWh/kW·year</div>
                  </div>
                  <div class="card">
                    <div class="label">3개년 평균 연간 탄소 절감량</div>
                    <div class="value">${formatNumber(scenario.avgAnnualCarbonReductionTon, 2)} tCO₂</div>
                  </div>
                </div>

                <table>
                  <thead>
                    <tr>
                      <th>연도</th>
                      <th>연간 발전량</th>
                      <th>연간 절감액</th>
                      <th>연간 탄소 절감량</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${yearlyRows}
                  </tbody>
                </table>
              </section>
            `;
          })
          .join("")
      : `<p class="empty">아직 3개년 평균 + PR 시나리오 계산을 실행하지 않았습니다.</p>`;

    popup.document.write(`
      <!DOCTYPE html>
      <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>태양광 분석 결과</title>
        <link
          rel="stylesheet"
          href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
        />
        <style>
          body {
            margin: 0;
            font-family: "Segoe UI", "Noto Sans KR", sans-serif;
            background: #f8fafc;
            color: #0f172a;
          }
          .topbar {
            position: sticky;
            top: 0;
            z-index: 1000;
            display: flex;
            justify-content: space-between;
            gap: 12px;
            align-items: center;
            padding: 16px 24px;
            background: rgba(255,255,255,0.92);
            backdrop-filter: blur(10px);
            border-bottom: 1px solid #e2e8f0;
          }
          .print-btn {
            border: 0;
            border-radius: 12px;
            padding: 10px 14px;
            background: #0f172a;
            color: white;
            font-weight: 700;
            cursor: pointer;
          }
          .wrap {
            max-width: 1200px;
            margin: 0 auto;
            padding: 24px;
          }
          h1 {
            margin: 0 0 10px;
            font-size: 2rem;
          }
          h2 {
            margin: 0 0 14px;
            font-size: 1.25rem;
          }
          .lead {
            color: #475569;
            line-height: 1.6;
            margin-bottom: 24px;
          }
          .meta {
            color: #64748b;
            font-size: 0.92rem;
            margin-top: 8px;
          }
          .section {
            background: white;
            border: 1px solid #e2e8f0;
            border-radius: 20px;
            padding: 20px;
            margin-bottom: 20px;
          }
          .grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 12px;
          }
          .card {
            background: #f8fafc;
            border-radius: 14px;
            padding: 14px;
          }
          .label {
            font-size: 0.82rem;
            color: #64748b;
            margin-bottom: 6px;
          }
          .value {
            font-size: 1.05rem;
            font-weight: 800;
          }
          #resultMap {
            width: 100%;
            height: 480px;
            border-radius: 18px;
            overflow: hidden;
          }
          .scenario-card {
            border: 1px solid #dbeafe;
            border-radius: 18px;
            padding: 16px;
            margin-bottom: 16px;
            background: #eff6ff;
          }
          .scenario-label {
            display: inline-block;
            margin-bottom: 12px;
            padding: 6px 10px;
            border-radius: 999px;
            background: #dbeafe;
            color: #1d4ed8;
            font-size: 0.85rem;
            font-weight: 800;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 14px;
          }
          th, td {
            border-bottom: 1px solid #e2e8f0;
            text-align: left;
            padding: 10px 8px;
            font-size: 0.95rem;
          }
          th {
            background: #f8fafc;
          }
          .empty {
            color: #64748b;
          }
          @media print {
            .topbar {
              display: none;
            }
            body {
              background: white;
            }
            .section {
              box-shadow: none;
              break-inside: avoid;
            }
          }
          @media (max-width: 800px) {
            .grid {
              grid-template-columns: 1fr;
            }
          }
        </style>
      </head>
      <body>
        <div class="topbar">
          <div><strong>태양광 분석 결과 보고서</strong></div>
          <button class="print-btn" onclick="window.print()">인쇄 / PDF 저장</button>
        </div>

        <div class="wrap">
          <h1>태양광 분석 결과</h1>
          <p class="lead">
            사용자가 직접 선택한 폴리곤을 기준으로 계산한 기본 결과와
            2023~2025년 실제 기상 데이터 기반 3개년 평균 + PR 시나리오 분석 결과입니다.
          </p>
          <div class="meta">
            전기요금 절감액 계산 가정: ${formatNumber(DEFAULT_ELECTRICITY_PRICE_KRW_PER_KWH)} 원/kWh<br />
            탄소 절감량 계산 가정: ${formatNumber(DEFAULT_GRID_EMISSION_KGCO2_PER_KWH, 3)} kgCO₂/kWh
          </div>

          <section class="section">
            <h2>선택한 폴리곤 지도</h2>
            <div id="resultMap"></div>
          </section>

          <section class="section">
            <h2>기본 계산 결과</h2>
            <div class="grid">
              <div class="card">
                <div class="label">건물 면적</div>
                <div class="value">${formatNumber(simple.roofArea)} ㎡</div>
              </div>
              <div class="card">
                <div class="label">설치 가능 면적</div>
                <div class="value">${formatNumber(simple.usableArea)} ㎡</div>
              </div>
              <div class="card">
                <div class="label">예상 설비 용량</div>
                <div class="value">${formatNumber(simple.capacityKw, 1)} kW</div>
              </div>
              <div class="card">
                <div class="label">연간 예상 발전량</div>
                <div class="value">${formatNumber(simple.annualGeneration)} kWh</div>
              </div>
              <div class="card">
                <div class="label">연간 예상 전기요금 절감액</div>
                <div class="value">${formatNumber(simple.annualSavingsKRW)} 원</div>
              </div>
              <div class="card">
                <div class="label">연간 예상 탄소 절감량</div>
                <div class="value">${formatNumber(simple.annualCarbonReductionTon, 2)} tCO₂</div>
              </div>
            </div>
          </section>

          <section class="section">
            <h2>3개년 평균 + PR 시나리오 결과</h2>
            ${scenarioHtml}
          </section>
        </div>

        <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
        <script>
          const coords = ${polygonCoordsText};
          const centerLat =
            coords.reduce((sum, p) => sum + p[0], 0) / coords.length;
          const centerLng =
            coords.reduce((sum, p) => sum + p[1], 0) / coords.length;

          const map = L.map("resultMap").setView([centerLat, centerLng], 19);

          L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 20,
            attribution: "&copy; OpenStreetMap contributors"
          }).addTo(map);

          const polygon = L.polygon(coords, {
            color: "#f97316",
            weight: 3,
            fillColor: "#fb923c",
            fillOpacity: 0.45
          }).addTo(map);

          map.fitBounds(polygon.getBounds(), { padding: [20, 20] });
        </script>
      </body>
      </html>
    `);

    popup.document.close();
  }

  const simpleEstimate = selectedBuilding
    ? estimateSimpleSolar(selectedBuilding.area)
    : null;

  const simpleWithExtra = simpleEstimate
    ? addEconomicAndCarbonMetrics({
        ...simpleEstimate,
        annualGenerationKWh: simpleEstimate.annualGeneration,
      })
    : null;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <p className="eyebrow">SMART SOLAR 2</p>
        <h1>태양광 잠재량 분석 지도</h1>
        <p className="lead">
          건물 꼭짓점을 직접 선택해 면적을 계산하고,
          2023~2025년 실제 기상 데이터와 PR 시나리오를 바탕으로
          발전량·절감액·탄소 절감량을 비교합니다.
        </p>

        <div className="panel">
          <h2>현재 상태</h2>
          <dl className="metric-list single-column">
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
            <div>
              <dt>찍은 점 개수</dt>
              <dd>{drawPoints.length}</dd>
            </div>
          </dl>

          <p className="status-text">{status}</p>

          <div className="action-row">
            <button onClick={completeDrawing}>폴리곤 완성</button>
            <button className="ghost-button" onClick={undoLastPoint}>
              마지막 점 지우기
            </button>
            <button className="ghost-button" onClick={clearDrawing}>
              초기화
            </button>
          </div>
        </div>

        <div className="panel">
          <h2>기본 계산 결과</h2>

          {!selectedBuilding && (
            <p className="empty-text">
              건물 모서리를 순서대로 클릭한 뒤, 폴리곤 완성을 눌러주세요.
            </p>
          )}

          {selectedBuilding && simpleWithExtra && (
            <dl className="metric-list single-column">
              <div>
                <dt>건물 면적</dt>
                <dd className="big-number">
                  {formatNumber(simpleWithExtra.roofArea)} ㎡
                </dd>
              </div>
              <div>
                <dt>설치 가능 면적</dt>
                <dd>{formatNumber(simpleWithExtra.usableArea)} ㎡</dd>
              </div>
              <div>
                <dt>예상 설비 용량</dt>
                <dd>{formatNumber(simpleWithExtra.capacityKw, 1)} kW</dd>
              </div>
              <div>
                <dt>연간 예상 발전량</dt>
                <dd>{formatNumber(simpleWithExtra.annualGeneration)} kWh</dd>
              </div>
              <div>
                <dt>연간 예상 전기요금 절감액</dt>
                <dd>{formatNumber(simpleWithExtra.annualSavingsKRW)} 원</dd>
              </div>
              <div>
                <dt>연간 예상 탄소 절감량</dt>
                <dd>{formatNumber(simpleWithExtra.annualCarbonReductionTon, 2)} tCO₂</dd>
              </div>
            </dl>
          )}
        </div>

        <div className="panel result-panel">
          <div className="panel-header">
            <h2>3개년 평균 + PR 시나리오</h2>
            <div className="action-row">
              <button
                onClick={analyzeWithMultiYearWeather}
                disabled={isLoadingWeather}
              >
                {isLoadingWeather ? "계산 중..." : "3개년 평균 + PR 시나리오 계산"}
              </button>
              <button className="ghost-button" onClick={openResultWindow}>
                결과 새 창으로 보기
              </button>
            </div>
          </div>

          {!multiYearResult && (
            <p className="empty-text">
              폴리곤을 완성한 뒤 버튼을 누르면 2023~2025년 실제 기상 데이터와
              PR 3개 시나리오를 바탕으로 계산합니다.
            </p>
          )}

          {multiYearResult && (
            <>
              {multiYearResult.scenarios.map((scenario) => {
                const cardClass =
                  scenario.label === "보수적"
                    ? "scenario-card conservative"
                    : scenario.label === "기준"
                    ? "scenario-card standard"
                    : "scenario-card optimistic";

                return (
                  <div key={scenario.label} className={cardClass}>
                    <div className="scenario-label">
                      {scenario.label} 시나리오 · PR {scenario.pr}
                    </div>

                    <dl className="metric-list single-column">
                      <div>
                        <dt>설치 가능 면적</dt>
                        <dd>{formatNumber(scenario.usableArea)} ㎡</dd>
                      </div>
                      <div>
                        <dt>예상 설비 용량</dt>
                        <dd>{formatNumber(scenario.installedCapacityKw, 1)} kW</dd>
                      </div>
                      <div>
                        <dt>3개년 평균 연간 발전량</dt>
                        <dd className="big-number">
                          {formatNumber(scenario.avgAnnualGenerationKWh)} kWh
                        </dd>
                      </div>
                      <div>
                        <dt>3개년 평균 월평균 발전량</dt>
                        <dd>{formatNumber(scenario.avgMonthlyGenerationKWh)} kWh</dd>
                      </div>
                      <div>
                        <dt>3개년 평균 특정수율</dt>
                        <dd>
                          {formatNumber(scenario.avgSpecificYield, 1)} kWh/kW·year
                        </dd>
                      </div>
                      <div>
                        <dt>3개년 평균 연간 절감액</dt>
                        <dd>{formatNumber(scenario.avgAnnualSavingsKRW)} 원</dd>
                      </div>
                      <div>
                        <dt>3개년 평균 월 절감액</dt>
                        <dd>{formatNumber(scenario.avgMonthlySavingsKRW)} 원</dd>
                      </div>
                      <div>
                        <dt>3개년 평균 연간 탄소 절감량</dt>
                        <dd>{formatNumber(scenario.avgAnnualCarbonReductionTon, 2)} tCO₂</dd>
                      </div>

                      {scenario.yearly.map((item) => (
                        <div key={item.year}>
                          <dt>{item.year}년 연간 발전량</dt>
                          <dd>{formatNumber(item.annualGenerationKWh)} kWh</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                );
              })}

              <p className="helper-note">
                보수적·기준·낙관적 시나리오는 성능비(PR)를 다르게 두어
                실제 운영 조건 차이에 따른 발전량·절감액·탄소 절감량 범위를 비교한 값이야.
              </p>
            </>
          )}
        </div>
      </aside>

      <main className="map-stage">
        {isLoadingWeather && (
          <div className="loading-chip">3개년 날씨 데이터 계산 중...</div>
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
          />

          {drawPoints.length > 0 && (
            <>
              <Polyline
                positions={drawPoints}
                pathOptions={{ color: "#2563eb", weight: 3 }}
              />
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
