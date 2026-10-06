/* ========== 火烧云预报 · 逻辑 ========== */

const $ = (id) => document.getElementById(id);

const DEFAULT_CITY = { name: '郑州', lat: 34.7466, lon: 113.6253 };

const WMO_TEXT = {
  0: '晴', 1: '基本晴', 2: '少云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨',
  56: '冻毛毛雨', 57: '冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
  80: '阵雨', 81: '阵雨', 82: '强阵雨',
  85: '阵雪', 86: '强阵雪',
  95: '雷雨', 96: '雷雨伴冰雹', 99: '强雷雨伴冰雹'
};

/* ---------- 预测模型 ---------- */

// 综合日落时分的 5 项指标，输出 0-100 的火烧云指数
function calcFireCloudScore(m) {
  // 1. 云量（满分 40）：30% - 70% 为黄金区间
  let cloudScore;
  if (m.cloud < 5) cloudScore = 6;
  else if (m.cloud <= 30) cloudScore = 10 + ((m.cloud - 5) / 25) * 25;
  else if (m.cloud <= 70) cloudScore = 40;
  else if (m.cloud <= 90) cloudScore = 40 - ((m.cloud - 70) / 20) * 20;
  else cloudScore = 10;

  // 2. 湿度（满分 20）：越低越通透
  let humScore = m.hum <= 40 ? 20 : Math.max(0, 20 - (m.hum - 40) * 0.35);

  // 3. 空气质量 US AQI（满分 20）：空气越洁净，霞色越鲜艳
  let aqiScore;
  if (m.aqi == null) aqiScore = 10;
  else if (m.aqi <= 30) aqiScore = 20;
  else if (m.aqi <= 100) aqiScore = 20 - ((m.aqi - 30) / 70) * 10;
  else if (m.aqi <= 200) aqiScore = 10 - ((m.aqi - 100) / 100) * 7;
  else aqiScore = 0;

  // 4. 能见度（满分 10）：>21km 满分，5km 归零
  let visScore = m.visKm == null ? 6 : Math.max(0, Math.min(10, (m.visKm - 5) * 0.6));

  // 5. 天气状况（满分 10）：晴天 / 少云最佳
  let wcScore;
  if (m.code <= 1) wcScore = 10;
  else if (m.code === 2) wcScore = 9;
  else if (m.code === 3) wcScore = 4;
  else if (m.code === 45 || m.code === 48) wcScore = 2;
  else wcScore = 0;

  return Math.round(cloudScore + humScore + aqiScore + visScore + wcScore);
}

function levelOf(score) {
  if (score >= 80) return { name: '极高', cls: 'lv-5', tip: '很大概率出现壮丽火烧云，值得提前蹲守机位。' };
  if (score >= 60) return { name: '较高', cls: 'lv-4', tip: '出现火烧云的概率较大，抓住日落前后黄金半小时。' };
  if (score >= 40) return { name: '中等', cls: 'lv-3', tip: '有一定机会，成败取决于云层的实时变化。' };
  if (score >= 20) return { name: '较低', cls: 'lv-2', tip: '可能性较小，建议留意临近时刻的云图变化。' };
  return { name: '很低', cls: 'lv-1', tip: '基本无缘，适合休息或安排其他行程。' };
}

function aqiLevelText(v) {
  if (v == null) return '暂无数据';
  if (v <= 50) return '优';
  if (v <= 100) return '良';
  if (v <= 150) return '轻度污染';
  if (v <= 200) return '中度污染';
  if (v <= 300) return '重度污染';
  return '严重污染';
}

/* ---------- 数据获取 ---------- */

const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
const AQI_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function fetchData(lat, lon) {
  const params = `latitude=${lat}&longitude=${lon}&timezone=auto&forecast_days=7`;
  const [w, a] = await Promise.all([
    fetchJson(`${WEATHER_URL}?${params}&hourly=cloud_cover,relative_humidity_2m,weather_code,visibility&daily=sunrise,sunset`),
    fetchJson(`${AQI_URL}?${params}&hourly=us_aqi`).catch(() => null)
  ]);
  return { w, a };
}

/* ---------- 数据处理 ---------- */

function pad2(n) { return String(n).padStart(2, '0'); }

// 计算某一天某个时刻（日出/日落）的预测指标
function buildEvent(date, timeStr, w, aqiMap) {
  if (!timeStr) return null;
  const hour = Number(timeStr.slice(11, 13));
  const t = timeStr.slice(11, 16);
  const candidates = [hour, hour - 1, hour + 1, hour - 2, hour + 2];
  let idx = -1;
  for (const h of candidates) {
    const tt = `${date}T${pad2(h)}:00`;
    const i = w.hourly.time.indexOf(tt);
    if (i !== -1) { idx = i; break; }
  }
  if (idx === -1) return null;

  const cloud = w.hourly.cloud_cover[idx];
  const hum = w.hourly.relative_humidity_2m[idx];
  const code = w.hourly.weather_code[idx];
  const visKm = w.hourly.visibility[idx] != null ? +(w.hourly.visibility[idx] / 1000).toFixed(1) : null;
  let aqi = null;
  for (const h of candidates) {
    const tt = `${date}T${pad2(h)}:00`;
    if (aqiMap.has(tt)) { aqi = aqiMap.get(tt); break; }
  }

  const score = calcFireCloudScore({ cloud, hum, aqi, visKm, code });
  return { time: t, hour, cloud, hum, code, visKm, aqi, score, lv: levelOf(score) };
}

function buildDays(w, a) {
  const now = Date.now();
  const aqiMap = new Map();
  if (a && a.hourly) {
    a.hourly.time.forEach((t, i) => {
      const v = a.hourly.us_aqi[i];
      if (v != null && !Number.isNaN(v)) aqiMap.set(t, v);
    });
  }

  const days = [];
  for (let di = 0; di < w.daily.time.length; di++) {
    const date = w.daily.time[di];
    const sunsetEv = buildEvent(date, w.daily.sunset[di], w, aqiMap);
    const sunriseEv = buildEvent(date, w.daily.sunrise[di], w, aqiMap);
    if (!sunsetEv || !sunriseEv) continue;

    days.push({
      date,
      sunsetTime: new Date(w.daily.sunset[di]).getTime(),
      sunriseTime: new Date(w.daily.sunrise[di]).getTime(),
      isPast: new Date(w.daily.sunset[di]).getTime() < now,
      sunset: sunsetEv,
      sunrise: sunriseEv
    });
  }
  return days;
}

function chartDataFor(w, day, mode) {
  const ev = day[mode];
  const out = [];
  for (let h = ev.hour - 3; h <= ev.hour + 2; h++) {
    const t = `${day.date}T${pad2(h)}:00`;
    const idx = w.hourly.time.indexOf(t);
    if (idx === -1) continue;
    out.push({ label: `${pad2(h)}:00`, cloud: w.hourly.cloud_cover[idx], isSunset: h === ev.hour });
  }
  return out;
}

/* ---------- 渲染 ---------- */

const state = {
  city: DEFAULT_CITY.name,
  lat: DEFAULT_CITY.lat,
  lon: DEFAULT_CITY.lon,
  province: '河南',
  w: null, a: null,
  days: [],
  selected: 0,
  mode: 'sunset' // 'sunset' 晚霞 | 'sunrise' 朝霞
};

function renderStars() {
  const wrap = $('stars');
  const n = 70;
  let html = '';
  for (let i = 0; i < n; i++) {
    const x = Math.random() * 100;
    const y = Math.random() * 60;
    const s = Math.random() * 1.6 + 1;
    const d = (Math.random() * 4).toFixed(1);
    html += `<span class="star" style="left:${x}%;top:${y}%;width:${s}px;height:${s}px;animation-delay:${d}s"></span>`;
  }
  wrap.innerHTML = html;
}

function renderGaugeTicks() {
  const g = $('gaugeTicks');
  const cx = 110, cy = 115, r1 = 77, r2 = 66;
  let html = '';
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI * (1 - i / 10);
    const x1 = cx + r1 * Math.cos(a), y1 = cy - r1 * Math.sin(a);
    const x2 = cx + r2 * Math.cos(a), y2 = cy - r2 * Math.sin(a);
    const major = i % 5 === 0;
    html += `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"
      stroke="${major ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.32)'}" stroke-width="${major ? 2.4 : 1.2}" stroke-linecap="round"/>`;
  }
  g.innerHTML = html;
}

function renderTabs() {
  const wrap = $('dayTabs');
  const todayStr = new Date().toISOString().slice(0, 10);
  wrap.innerHTML = state.days.map((d, i) => {
    const label = dateLabel(d.date, todayStr);
    const dot = scoreDotColor(d.score);
    return `<button class="day-tab${i === state.selected ? ' active' : ''}" data-i="${i}" role="tab">` +
      `<span class="mini-dot" style="background:${dot}"></span>${label}` +
      `</button>`;
  }).join('');
  wrap.querySelectorAll('.day-tab').forEach(btn => {
    btn.addEventListener('click', () => selectDay(Number(btn.dataset.i)));
  });
}

function dateLabel(dateStr, todayStr) {
  if (dateStr === todayStr) return '今天';
  const next = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  if (dateStr === next) return '明天';
  const wd = new Date(dateStr + 'T12:00').toLocaleDateString('zh-CN', { weekday: 'short' });
  return `${dateStr.slice(5).replace('-', '/')} ${wd}`;
}

function scoreDotColor(score) {
  if (score >= 80) return '#ff5252';
  if (score >= 60) return '#ff9a3c';
  if (score >= 40) return '#ffd194';
  if (score >= 20) return '#8fa6e8';
  return '#6660a0';
}

function renderDay() {
  const d = state.days[state.selected];
  if (!d) return;
  const mode = state.mode;
  const ev = d[mode];
  if (!ev) return;
  const modeName = mode === 'sunset' ? '晚霞' : '朝霞';
  const sunWord = mode === 'sunset' ? '日落' : '日出';

  $('scoreNum').textContent = ev.score;
  const lvEl = $('scoreLevel');
  lvEl.textContent = modeName + '指数 · ' + ev.lv.name;
  lvEl.className = 'score-level ' + ev.lv.cls;
  $('gaugeTitle').textContent = '今日' + modeName + '指数（' + sunWord + '）';
  $('gaugeTip').textContent = ev.lv.tip;
  $('bestTimeVal').textContent = `${addMinutes(ev.time, -15)} ~ ${addMinutes(ev.time, 30)}`;
  $('chartDay').textContent = dateLabel(d.date, new Date().toISOString().slice(0, 10)) + ' · ' + sunWord + ' ' + ev.time;
  $('chartTitle').textContent = sunWord + '前后云量变化';
  $('chartNote').textContent = '柱高代表云量百分比，金色为' + sunWord + '时刻前后，云量在 30% - 70% 之间最易出现' + modeName + '。';

  // 仪表盘
  const arc = $('gaugeArc');
  const len = 267;
  arc.style.strokeDashoffset = String(len - (len * ev.score) / 100);
  const ang = Math.PI * (1 - ev.score / 100);
  const gcx = 110, gcy = 115, gr = 85;
  const tx = gcx + gr * Math.cos(ang);
  const ty = gcy - gr * Math.sin(ang);
  $('needleLine').setAttribute('x2', tx.toFixed(2));
  $('needleLine').setAttribute('y2', ty.toFixed(2));
  const knob = $('gaugeKnob');
  knob.setAttribute('cx', tx.toFixed(2));
  knob.setAttribute('cy', ty.toFixed(2));

  // 指标
  $('metric-sun-label').textContent = sunWord + '时间';
  $('metric-sunset').textContent = ev.time;
  $('metric-sunset-sub').textContent = mode === 'sunset' ? '日落前 15 分钟开始等待' : '日出前 15 分钟到达机位';
  $('metric-cloud-label').textContent = sunWord + '时云量';
  $('metric-cloud').textContent = ev.cloud != null ? ev.cloud + '%' : '--';
  $('metric-cloud-sub').textContent = cloudHint(ev.cloud);
  $('metric-hum').textContent = ev.hum != null ? ev.hum + '%' : '--';
  $('metric-hum-sub').textContent = humHint(ev.hum);
  $('metric-aqi').textContent = ev.aqi != null ? ev.aqi : '暂无';
  $('metric-aqi-sub').textContent = aqiLevelText(ev.aqi);
  $('metric-vis').textContent = ev.visKm != null ? ev.visKm + ' km' : '暂无';
  $('metric-vis-sub').textContent = ev.visKm != null && ev.visKm >= 15 ? '视野通透' : '能见度一般';
  $('metric-weather').textContent = WMO_TEXT[ev.code] || '--';
  $('metric-weather-sub').textContent = codeHint(ev.code);

  renderChart();
  renderTrend();
  renderForecast();
  renderTabs();
}

function renderTrend() {
  const svg = $('trendSvg');
  const days = state.days;
  if (!days || days.length < 2) { svg.innerHTML = ''; return; }
  const w = 240, h = 48, pad = 7;
  const max = Math.max(...days.map(d => d.score), 100);
  const pts = days.map((d, i) => [
    pad + (i / (days.length - 1)) * (w - pad * 2),
    h - pad - (d.score / max) * (h - pad * 2)
  ]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const area = line + ` L${(w - pad).toFixed(1)},${h - pad} L${pad},${h - pad} Z`;
  const sel = pts[Math.min(state.selected, pts.length - 1)];
  svg.innerHTML =
    `<defs><linearGradient id="trendGrad" x1="0" y1="0" x2="1" y2="0">` +
    `<stop offset="0" stop-color="#5b8def"/><stop offset="1" stop-color="#ff9a3c"/></linearGradient>` +
    `<linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="rgba(255,154,60,0.35)"/><stop offset="1" stop-color="rgba(255,154,60,0.02)"/></linearGradient></defs>` +
    `<path d="${area}" fill="url(#trendFill)"/>` +
    `<path d="${line}" fill="none" stroke="url(#trendGrad)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="${sel[0].toFixed(1)}" cy="${sel[1].toFixed(1)}" r="3.5" fill="#ffd194" stroke="#fff" stroke-width="1.2"/>`;
}

function addMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + mins;
  return `${pad2(Math.floor(total / 60) % 24)}:${pad2(total % 60)}`;
}

function cloudHint(c) {
  if (c == null) return '--';
  if (c < 5) return '天空太干净，无云可染';
  if (c < 30) return '云量偏少，霞色略淡';
  if (c <= 70) return '云量适中，最容易出霞';
  if (c <= 90) return '云层偏厚，光线受阻';
  return '阴天，基本看不到';
}

function humHint(h) {
  if (h == null) return '--';
  if (h <= 45) return '湿度低，天空通透';
  if (h <= 70) return '湿度适中';
  if (h <= 85) return '湿度偏高，略有霾';
  return '湿度很高，视野朦胧';
}

function codeHint(c) {
  if (c == null) return '--';
  if (c <= 2) return '晴天，利于霞光';
  if (c === 3) return '阴天，云层过厚';
  if (c === 45 || c === 48) return '有雾，能见度差';
  return '有降水，基本无望';
}

function renderChart() {
  const d = state.days[state.selected];
  const mode = state.mode;
  const ev = d[mode];
  const wrap = $('cloudChart');
  const items = chartDataFor(state.w, d, mode);
  const maxCloud = Math.max(...items.map(x => x.cloud), 10);
  const sunsetIdx = items.findIndex(x => x.isSunset);

  wrap.innerHTML = '';
  items.forEach((x, i) => {
    const bar = document.createElement('div');
    bar.className = 'bar' + (x.isSunset ? ' sunset-bar' : '');
    bar.style.height = Math.max(4, (x.cloud / maxCloud) * 100) + '%';
    bar.style.background = barColor(i, items.length);
    bar.innerHTML = `<div class="bar-val">${x.cloud}%</div><span class="bar-label">${x.label}</span>`;
    wrap.appendChild(bar);
  });

  if (sunsetIdx !== -1) {
    const line = document.createElement('div');
    line.className = 'sunset-line';
    const total = items.length;
    const pos = ((sunsetIdx + 0.5) / total) * 100;
    line.style.left = pos + '%';
    line.innerHTML = `<span>${mode === 'sunset' ? '日落' : '日出'} ${ev.time}</span>`;
    wrap.appendChild(line);
  }
}

function barColor(i, total) {
  const t = total <= 1 ? 0 : i / (total - 1);
  // 从冷色 → 紫 → 橙红渐变
  const stops = [
    [94, 108, 247],
    [176, 108, 247],
    [255, 154, 60]
  ];
  const seg = Math.min(2, Math.floor(t * 2));
  const f = (t * 2) - seg;
  const c1 = stops[seg];
  const c2 = stops[Math.min(2, seg + 1)];
  const r = Math.round(c1[0] + (c2[0] - c1[0]) * f);
  const g = Math.round(c1[1] + (c2[1] - c1[1]) * f);
  const b = Math.round(c1[2] + (c2[2] - c1[2]) * f);
  return `linear-gradient(180deg, rgba(${r},${g},${b},0.95), rgba(${r},${g},${b},0.6))`;
}

function renderForecast() {
  const wrap = $('forecastGrid');
  const mode = state.mode;
  const sunWord = mode === 'sunset' ? '日落' : '日出';
  wrap.innerHTML = state.days.map((d, i) => {
    const ev = d[mode];
    const todayStr = new Date().toISOString().slice(0, 10);
    const wd = new Date(d.date + 'T12:00').toLocaleDateString('zh-CN', { weekday: 'short' });
    return `<div class="fc-item${i === state.selected ? ' active' : ''}" data-i="${i}">` +
      `<div class="fc-date">${d.date.slice(5).replace('-', '/')} ${wd}${d.date === todayStr ? '·今天' : ''}</div>` +
      `<div class="fc-score">${ev.score}</div>` +
      `<div class="fc-level">${ev.lv.name}</div>` +
      `<div class="fc-cloud">${sunWord} ${ev.time} · 云 ${ev.cloud != null ? ev.cloud + '%' : '--'}</div>` +
      `</div>`;
  }).join('');
  wrap.querySelectorAll('.fc-item').forEach(el => {
    el.addEventListener('click', () => selectDay(Number(el.dataset.i)));
  });
}

function selectDay(i) {
  state.selected = i;
  renderDay();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------- 定位与搜索 ---------- */

function loadCity(lat, lon, name, province) {
  state.lat = lat;
  state.lon = lon;
  state.city = name;
  state.province = province || CITY_TO_PROVINCE[name] || nearestProvince(lat, lon) || state.province;
  $('cityName').textContent = name;
  $('updateTime').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  updateMapCurrentPoint(lat, lon);
  loadProvincePoints();
  loadData();
}

async function loadData() {
  $('errorBox').classList.add('hidden');
  try {
    const { w, a } = await fetchData(state.lat, state.lon);
    state.w = w;
    state.a = a;
    state.days = buildDays(w, a);
    if (!state.days.length) throw new Error('no data');
    // 默认选中第一个日落还没过去的日期
    const firstFuture = state.days.findIndex(d => !d.isPast);
    state.selected = firstFuture === -1 ? 0 : firstFuture;
    renderDay();
  } catch (err) {
    console.error(err);
    $('errorMsg').textContent = '数据加载失败，请检查网络后重试。';
    $('errorBox').classList.remove('hidden');
  }
}

function locate() {
  $('cityName').textContent = '定位中…';
  const fallback = () => ipLocate();
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => loadCity(pos.coords.latitude, pos.coords.longitude, '我的位置'),
      fallback,
      { timeout: 8000, maximumAge: 60000 }
    );
  } else {
    fallback();
  }
}

async function ipLocate() {
  try {
    const j = await fetchJson('https://ipapi.co/json/');
    if (j && j.latitude != null) {
      loadCity(j.latitude, j.longitude, j.city || '当前位置');
      return;
    }
  } catch (e) { /* 继续兜底 */ }
  loadCity(DEFAULT_CITY.lat, DEFAULT_CITY.lon, DEFAULT_CITY.name);
}

async function searchCity(name) {
  try {
    const j = await fetchJson(`${GEO_URL}?name=${encodeURIComponent(name)}&count=5&language=zh&format=json`);
    return (j && j.results) || [];
  } catch (e) {
    return [];
  }
}

/* ---------- 全国指数地图 ---------- */

const MAP_CITIES = [
  { name: '北京', lng: 116.407, lat: 39.904 },
  { name: '上海', lng: 121.473, lat: 31.230 },
  { name: '广州', lng: 113.264, lat: 23.129 },
  { name: '深圳', lng: 114.057, lat: 22.543 },
  { name: '天津', lng: 117.190, lat: 39.125 },
  { name: '重庆', lng: 106.551, lat: 29.563 },
  { name: '郑州', lng: 113.625, lat: 34.747 },
  { name: '石家庄', lng: 114.514, lat: 38.042 },
  { name: '太原', lng: 112.549, lat: 37.857 },
  { name: '呼和浩特', lng: 111.749, lat: 40.842 },
  { name: '沈阳', lng: 123.431, lat: 41.805 },
  { name: '长春', lng: 125.323, lat: 43.817 },
  { name: '哈尔滨', lng: 126.535, lat: 45.803 },
  { name: '南京', lng: 118.796, lat: 32.060 },
  { name: '杭州', lng: 120.155, lat: 30.274 },
  { name: '合肥', lng: 117.227, lat: 31.820 },
  { name: '福州', lng: 119.296, lat: 26.074 },
  { name: '南昌', lng: 115.858, lat: 28.682 },
  { name: '济南', lng: 117.120, lat: 36.651 },
  { name: '武汉', lng: 114.305, lat: 30.593 },
  { name: '长沙', lng: 112.938, lat: 28.228 },
  { name: '南宁', lng: 108.366, lat: 22.817 },
  { name: '海口', lng: 110.199, lat: 20.044 },
  { name: '成都', lng: 104.066, lat: 30.572 },
  { name: '贵阳', lng: 106.630, lat: 26.647 },
  { name: '昆明', lng: 102.832, lat: 24.880 },
  { name: '拉萨', lng: 91.140, lat: 29.645 },
  { name: '西安', lng: 108.940, lat: 34.341 },
  { name: '兰州', lng: 103.834, lat: 36.061 },
  { name: '西宁', lng: 101.778, lat: 36.617 },
  { name: '银川', lng: 106.232, lat: 38.487 },
  { name: '乌鲁木齐', lng: 87.617, lat: 43.793 },
  { name: '青岛', lng: 120.382, lat: 36.067 },
  { name: '厦门', lng: 118.089, lat: 24.480 },
  { name: '苏州', lng: 120.619, lat: 31.317 },
  { name: '大理', lng: 100.267, lat: 25.606 },
  { name: '丽江', lng: 100.233, lat: 26.872 },
  { name: '三亚', lng: 109.512, lat: 18.252 },
  { name: '桂林', lng: 110.290, lat: 25.274 },
  { name: '洛阳', lng: 112.454, lat: 34.620 },
  { name: '张家界', lng: 110.479, lat: 29.117 },
  { name: '敦煌', lng: 94.662, lat: 40.142 },
  { name: '秦皇岛', lng: 119.600, lat: 39.935 }
];

function loadScript(src) {
  return new Promise(resolve => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

/* ---------- 省份城市点位（cities-data.js） ---------- */

const PROVINCE_CITIES = window.PROVINCE_CITIES || {};
const CITY_TO_PROVINCE = {};
Object.keys(PROVINCE_CITIES).forEach(p => {
  PROVINCE_CITIES[p].forEach(c => { CITY_TO_PROVINCE[c.name] = p; });
});

// 把「河南省/广西壮族自治区/北京市…」归一化为数据集里的省份键
function provinceKeyOf(name) {
  if (!name) return null;
  const s = String(name).replace(/省|市|壮族|回族|维吾尔|特别行政区|自治州|自治区|地区|盟/g, '');
  if (PROVINCE_CITIES[s]) return s;
  for (const k of Object.keys(PROVINCE_CITIES)) {
    if (String(name).includes(k)) return k;
  }
  return null;
}

// 根据经纬度找最近的省份（定位时没有城市名可推断省份）
function nearestProvince(lat, lon) {
  let best = null, bestD = Infinity;
  const cLat = Math.cos((lat * Math.PI) / 180);
  Object.keys(PROVINCE_CITIES).forEach(p => {
    PROVINCE_CITIES[p].forEach(c => {
      const d = (c.lat - lat) * (c.lat - lat) + (c.lng - lon) * (c.lng - lon) * cLat * cLat;
      if (d < bestD) { bestD = d; best = p; }
    });
  });
  return best;
}

const provinceCache = new Map();

async function fetchCityScores(cities) {
  const out = [];
  const CONC = 8;
  for (let i = 0; i < cities.length; i += CONC) {
    const batch = cities.slice(i, i + CONC).map(async c => ({ name: c.name, score: await fetchCityIndex(c) }));
    out.push(...await Promise.all(batch));
  }
  return out;
}

// 拉取当前省份各城市指数并在地图上显示（橙色小点）
async function loadProvincePoints() {
  if (!mapChart || !state.province) return;
  const key = state.province;
  let data = provinceCache.get(key);
  if (!data) {
    const cities = PROVINCE_CITIES[key] || [];
    const mainNames = new Set(MAP_CITIES.map(c => c.name));
    const scores = await fetchCityScores(cities);
    data = scores.filter(d => d.score != null && !mainNames.has(d.name));
    provinceCache.set(key, data);
  }
  if (!mapChart || state.province !== key) return;
  const cities = PROVINCE_CITIES[key] || [];
  mapChart.setOption({ series: [{}, {}, {}, {}, { data: data.map(d => {
    const c = cities.find(x => x.name === d.name);
    return { name: d.name, score: d.score, value: [c.lng, c.lat, d.score] };
  })}] });
}

// 获取某城市今日晚霞简化指数（不含空气质量与能见度）
async function fetchCityIndex(city) {
  try {
    const url = `${WEATHER_URL}?latitude=${city.lat}&longitude=${city.lng}&timezone=auto&forecast_days=1&hourly=cloud_cover,relative_humidity_2m,weather_code&daily=sunrise,sunset`;
    const w = await fetchJson(url);
    const date = w.daily.time[0];
    const hour = Number(w.daily.sunset[0].slice(11, 13));
    const candidates = [hour, hour - 1, hour + 1];
    let idx = -1;
    for (const h of candidates) {
      const i = w.hourly.time.indexOf(`${date}T${pad2(h)}:00`);
      if (i !== -1) { idx = i; break; }
    }
    if (idx === -1) return null;
    return calcFireCloudScore({
      cloud: w.hourly.cloud_cover[idx],
      hum: w.hourly.relative_humidity_2m[idx],
      code: w.hourly.weather_code[idx],
      aqi: null,
      visKm: null
    });
  } catch (e) {
    return null;
  }
}

async function loadMapData() {
  const note = $('mapNote');
  const data = [];
  const CONC = 8;
  for (let i = 0; i < MAP_CITIES.length; i += CONC) {
    const batch = MAP_CITIES.slice(i, i + CONC).map(async c => ({ name: c.name, score: await fetchCityIndex(c) }));
    const res = await Promise.all(batch);
    data.push(...res);
    note.textContent = `地图数据加载中… ${Math.min(i + CONC, MAP_CITIES.length)}/${MAP_CITIES.length}`;
  }
  note.textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · 简化指数（未计空气质量）`;
  return data;
}

let mapChart = null;

// 地图视野模式：true = 聚焦当前城市附近 200km；false = 全国视野
let mapFocus = true;
const FOCUS_ZOOM = 6;
const FULL_ZOOM = 1.15;
const MAP_CENTER = [104.3, 35.85];

// 地图上标记当前查询城市（蓝点）
function updateMapCurrentPoint(lat, lon) {
  if (!mapChart) return;
  mapChart.setOption({ series: [{}, {}, { data: [[lon, lat, 0]] }] });
  if (mapFocus) setFocusGeo(lat, lon);
}

// 估算 200km 半径在当前地图缩放下对应的像素
function rangeRadiusPx(lon, lat) {
  const dLon = 200 / (111.32 * Math.cos((lat * Math.PI) / 180));
  const p1 = mapChart.convertToPixel({ geoIndex: 0 }, [lon, lat]);
  const p2 = mapChart.convertToPixel({ geoIndex: 0 }, [lon + dLon, lat]);
  return Math.max(10, Math.abs(p2[0] - p1[0]));
}

// 更新 200km 范围圆环（仅聚焦模式下显示）
function updateRangeCircle(lon, lat) {
  if (!mapChart || !mapFocus) return;
  const r = rangeRadiusPx(lon, lat);
  mapChart.setOption({ series: [{}, {}, {}, { data: [{ value: [lon, lat, 0], symbolSize: 2 * r }] }] });
}

// 聚焦到某城市附近 200km
function setFocusGeo(lat, lon) {
  mapChart.setOption({
    geo: { center: [lon, lat], zoom: FOCUS_ZOOM },
    series: [{ pointSize: 34, blurSize: 62 }, {}, {}, {}]
  });
  updateRangeCircle(lon, lat);
}

// 展开为全国视野
function showFullMap() {
  if (!mapChart) return;
  mapFocus = false;
  mapChart.setOption({
    geo: { center: MAP_CENTER, zoom: FULL_ZOOM },
    series: [{ pointSize: 26, blurSize: 46 }, {}, {}, { data: [] }]
  });
  $('mapToggle').textContent = '附近 200km';
}

// 回到当前城市附近 200km 聚焦
function showFocusMap() {
  if (!mapChart) return;
  mapFocus = true;
  setFocusGeo(state.lat, state.lon);
  $('mapToggle').textContent = '查看全国';
}

async function initChinaMap() {
  const note = $('mapNote');
  try {
    let loaded = await loadScript('https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js');
    if (!loaded) loaded = await loadScript('https://unpkg.com/echarts@5.4.3/dist/echarts.min.js');
    if (!loaded || !window.echarts) throw new Error('ECharts 加载失败');

    let geo = null;
    for (const src of [
      'https://cdn.jsdelivr.net/npm/echarts@4.9.0/map/json/china.json',
      'https://unpkg.com/echarts@4.9.0/map/json/china.json'
    ]) {
      try {
        geo = await fetchJson(src);
        break;
      } catch (e) { /* 尝试下一个数据源 */ }
    }
    if (!geo || !geo.features) throw new Error('中国地图数据加载失败');
    window.echarts.registerMap('china', geo);

    const data = await loadMapData();
    const el = $('chinaMap');
    const chart = window.echarts.init(el);
    mapChart = chart;
    const heatData = data.filter(d => d.score != null).map(d => {
      const c = MAP_CITIES.find(x => x.name === d.name);
      return [c.lng, c.lat, d.score];
    });
    chart.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        backgroundColor: 'rgba(20,16,45,0.92)',
        borderColor: 'rgba(255,255,255,0.2)',
        textStyle: { color: '#f4f0ff', fontSize: 12 },
        formatter: p => {
          if (p.seriesType === 'heatmap') return `晚霞指数：<b>${p.value[2]}</b>`;
          return `${p.name}<br/>晚霞指数：<b>${p.data.score == null ? '暂无数据' : p.data.score}</b>`;
        }
      },
      visualMap: {
        type: 'continuous',
        min: 0,
        max: 100,
        calculable: true,
        seriesIndex: 0,
        orient: 'horizontal',
        left: 'center',
        bottom: 6,
        itemWidth: 12,
        itemHeight: 150,
        text: ['高', '低'],
        textGap: 8,
        textStyle: { color: '#cfc8f0', fontSize: 11 },
        inRange: { color: ['rgba(255,241,118,0.35)', 'rgba(255,167,38,0.5)', 'rgba(255,82,82,0.6)'] },
        backgroundColor: 'rgba(20,16,45,0.6)',
        borderColor: 'rgba(255,255,255,0.18)',
        borderWidth: 1,
        padding: 8
      },
      geo: {
        map: 'china',
        roam: true,
        zoom: 1.15,
        itemStyle: { areaColor: 'rgba(255,255,255,0.06)', borderColor: 'rgba(255,255,255,0.35)', borderWidth: 1 },
        emphasis: { itemStyle: { areaColor: 'rgba(255,170,90,0.18)' }, label: { show: false } }
      },
      series: [
        {
          type: 'heatmap',
          coordinateSystem: 'geo',
          zlevel: 1,
          pointSize: 26,
          blurSize: 46,
          data: heatData
        },
        {
          type: 'scatter',
          coordinateSystem: 'geo',
          zlevel: 2,
          data: data.map(d => {
            const c = MAP_CITIES.find(x => x.name === d.name);
            return { name: d.name, score: d.score, value: [c.lng, c.lat, d.score] };
          }),
          symbolSize: val => (val[2] == null ? 0 : 7 + (val[2] / 100) * 8),
          itemStyle: { color: '#ff5252' },
          label: {
            show: true,
            position: 'right',
            formatter: p => (p.data.score != null && p.data.score >= 60) ? p.name + ' ' + p.data.score : '',
            color: '#ffd9a8',
            fontSize: 11,
            fontWeight: 600
          },
          emphasis: {
            scale: 1.6,
            label: {
              show: true,
              position: 'right',
              formatter: p => p.name + ' ' + (p.data.score == null ? '--' : p.data.score),
              color: '#fff',
              fontSize: 13,
              fontWeight: 'bold',
              backgroundColor: 'rgba(20,16,45,0.85)',
              padding: [4, 8],
              borderRadius: 6
            }
          }
        },
        {
          type: 'scatter',
          coordinateSystem: 'geo',
          zlevel: 3,
          name: '当前位置',
          symbol: 'pin',
          symbolSize: 22,
          itemStyle: { color: '#4fc3f7', borderColor: '#ffffff', borderWidth: 2 },
          label: {
            show: true,
            formatter: '当前位置',
            position: 'top',
            color: '#fff',
            fontSize: 11,
            fontWeight: 600,
            backgroundColor: 'rgba(20,16,45,0.7)',
            padding: [2, 6],
            borderRadius: 4
          },
          data: [[DEFAULT_CITY.lon, DEFAULT_CITY.lat, 0]]
        },
        {
          // 当前城市附近 200km 范围圆环（聚焦模式下显示）
          type: 'scatter',
          coordinateSystem: 'geo',
          zlevel: 2,
          symbol: 'circle',
          silent: true,
          tooltip: { show: false },
          itemStyle: {
            color: 'rgba(79,195,247,0.08)',
            borderColor: 'rgba(79,195,247,0.85)',
            borderWidth: 2
          },
          label: {
            show: true,
            formatter: '200km',
            position: 'right',
            distance: 6,
            color: '#9fe2ff',
            fontSize: 11,
            fontWeight: 600,
            backgroundColor: 'rgba(20,16,45,0.55)',
            padding: [2, 6],
            borderRadius: 4
          },
          data: []
        },
        {
          // 当前城市所在省份的各城市点位（橙色小点，带指数）
          type: 'scatter',
          coordinateSystem: 'geo',
          zlevel: 2,
          symbolSize: val => (val[2] == null ? 0 : 6 + (val[2] / 100) * 6),
          itemStyle: { color: '#ffb74d' },
          label: {
            show: true,
            position: 'right',
            formatter: p => (p.data.score != null && p.data.score >= 60) ? p.name + ' ' + p.data.score : '',
            color: '#ffe0b0',
            fontSize: 10,
            fontWeight: 600
          },
          emphasis: {
            scale: 1.5,
            label: {
              show: true,
              position: 'right',
              formatter: p => p.name + ' ' + (p.data.score == null ? '--' : p.data.score),
              color: '#fff',
              fontSize: 12,
              fontWeight: 'bold',
              backgroundColor: 'rgba(20,16,45,0.85)',
              padding: [3, 6],
              borderRadius: 5
            }
          },
          data: []
        }
      ]
    });

    chart.on('click', p => {
      const c = MAP_CITIES.find(x => x.name === p.name);
      if (c) { loadCity(c.lat, c.lng, c.name); return; }
      // 省份城市点位也可点击切换查询
      const key = state.province;
      if (key && PROVINCE_CITIES[key]) {
        const pc = PROVINCE_CITIES[key].find(x => x.name === p.name);
        if (pc) loadCity(pc.lat, pc.lng, pc.name, key);
      }
    });
    // 拖拽/缩放时保持 200km 圆环贴合实际距离
    chart.on('georoam', () => updateRangeCircle(state.lat, state.lon));
    $('mapToggle').addEventListener('click', () => {
      if (mapFocus) showFullMap(); else showFocusMap();
    });
    window.addEventListener('resize', () => chart.resize());
    showFocusMap();
    loadProvincePoints();
  } catch (e) {
    console.warn('地图初始化失败：', e);
    note.textContent = '地图加载失败，请检查网络后刷新页面';
  }
}

/* ---------- 照片投稿墙 ---------- */

const GALLERY_KEY = 'fc_gallery_v1';
const GALLERY_MAX = 30;

function getGallery() {
  try { return JSON.parse(localStorage.getItem(GALLERY_KEY)) || []; } catch (e) { return []; }
}

function saveGallery(list) {
  try {
    localStorage.setItem(GALLERY_KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    alert('本地存储空间不足，请先删除部分旧照片再投稿。');
    return false;
  }
}

// 压缩图片为 JPEG dataURL（最长边 ≤ 900px）
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const MAX = 900;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}

// 在照片上绘制署名水印（名字或匿名 + 日期）
function applyWatermark(dataURL, name, dateStr) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, canvas.height - 56, canvas.width, 56);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 26px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 6;
      ctx.fillText((name || '匿名') + ' · ' + dateStr, 18, canvas.height - 28);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.src = dataURL;
  });
}

function renderGallery() {
  const list = getGallery();
  const grid = $('galleryGrid');
  const empty = $('galleryEmpty');
  grid.innerHTML = '';
  empty.classList.toggle('hidden', list.length > 0);
  list.forEach(item => {
    const card = document.createElement('figure');
    card.className = 'gallery-item';

    const img = document.createElement('img');
    img.src = item.dataURL;
    img.alt = item.name || '匿名';

    const fig = document.createElement('figcaption');
    fig.textContent = (item.name || '匿名') + ' · ' + item.date;

    const dl = document.createElement('a');
    dl.className = 'gallery-dl';
    dl.textContent = '下载';
    dl.href = item.dataURL;
    dl.download = 'huoshaoyun-' + item.date.replace(/\//g, '-') + '.jpg';

    const del = document.createElement('button');
    del.className = 'gallery-del';
    del.textContent = '删除';
    del.onclick = () => {
      const next = getGallery().filter(x => x.id !== item.id);
      if (saveGallery(next)) renderGallery();
    };

    const ops = document.createElement('div');
    ops.className = 'gallery-ops';
    ops.append(dl, del);

    card.append(img, fig, ops);
    grid.appendChild(card);
  });
}

async function handleGalleryFile(file) {
  try {
    const raw = await compressImage(file);
    const name = ($('galleryName').value || '').trim();
    const date = new Date().toLocaleDateString('zh-CN');
    const watermarked = await applyWatermark(raw, name, date);
    const list = getGallery();
    list.unshift({ id: Date.now(), dataURL: watermarked, name, date });
    while (list.length > GALLERY_MAX) list.pop();
    if (saveGallery(list)) {
      $('galleryName').value = '';
      $('galleryFile').value = '';
      $('gallerySubmit').disabled = true;
      renderGallery();
      $('galleryGrid').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  } catch (e) {
    alert('图片处理失败，请换一张试试。');
  }
}

/* ---------- 事件绑定 ---------- */

function init() {
  renderStars();
  renderGaugeTicks();

  $('searchBtn').addEventListener('click', async () => {
    const name = $('cityInput').value.trim();
    if (!name) return;
    const results = await searchCity(name);
    if (!results.length) {
      $('cityName').textContent = state.city;
      $('errorMsg').textContent = `未找到城市「${name}」，换个关键词试试。`;
      $('errorBox').classList.remove('hidden');
      return;
    }
    const hit = results[0];
    const display = [hit.name, hit.admin1 && hit.admin1 !== hit.name ? hit.admin1 : '', hit.country].filter(Boolean).join(' · ');
    loadCity(hit.latitude, hit.longitude, display || hit.name, provinceKeyOf(hit.admin1) || undefined);
  });

  $('cityInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('searchBtn').click();
  });

  $('locateBtn').addEventListener('click', locate);
  $('retryBtn').addEventListener('click', loadData);

  // 照片投稿墙
  renderGallery();
  $('galleryFile').addEventListener('change', e => {
    $('gallerySubmit').disabled = !e.target.files[0];
  });
  $('gallerySubmit').addEventListener('click', () => {
    const f = $('galleryFile').files[0];
    if (f) handleGalleryFile(f);
  });
  $('galleryClear').addEventListener('click', () => {
    if (confirm('确定清空全部投稿照片吗？')) {
      if (saveGallery([])) renderGallery();
    }
  });

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.mode = btn.dataset.mode;
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderDay();
    });
  });

  loadCity(DEFAULT_CITY.lat, DEFAULT_CITY.lon, DEFAULT_CITY.name);
  initChinaMap();
}

document.addEventListener('DOMContentLoaded', init);
