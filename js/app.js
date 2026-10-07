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
const PHOTON_URL = 'https://photon.komoot.io/api/';

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// 带重试的请求：Photon 等免费接口偶发限流/抖动，失败后自动重试，避免静默返回空结果
async function fetchJsonRetry(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetchJson(url);
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr;
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
  wrap.innerHTML = state.days.map((d, i) => {
    const label = dateLabel(d.date);
    const ev = d[state.mode];
    const dot = scoreDotColor(ev ? ev.score : null);
    return `<button class="day-tab${i === state.selected ? ' active' : ''}" data-i="${i}" role="tab">` +
      `<span class="mini-dot" style="background:${dot}"></span>${label}` +
      `</button>`;
  }).join('');
  wrap.querySelectorAll('.day-tab').forEach(btn => {
    btn.addEventListener('click', () => selectDay(Number(btn.dataset.i)));
  });
}

function dateLabel(dateStr) {
  // 以 Open-Meteo 返回的城市时区日期作为"今天"基准（修复 UTC 时差导致误判为"明天"）
  const todayStr = state.w && state.w.daily && state.w.daily.time[0];
  if (todayStr && dateStr === todayStr) return '今天';
  const tomorrowStr = state.w && state.w.daily && state.w.daily.time[1];
  if (tomorrowStr && dateStr === tomorrowStr) return '明天';
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
  $('chartDay').textContent = dateLabel(d.date) + ' · ' + sunWord + ' ' + ev.time;
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
  const mode = state.mode;
  // 评分存放在每天对应模式（晚霞/朝霞）的事件对象里，不是 day.score
  const scores = days.map(d => (d[mode] && d[mode].score != null ? d[mode].score : null));
  const nums = scores.filter(s => s != null);
  if (nums.length < 2) { svg.innerHTML = ''; return; }
  const w = 240, h = 48, pad = 7;
  const max = Math.max(...nums, 100);
  const pts = days.map((d, i) => [
    pad + (i / (days.length - 1)) * (w - pad * 2),
    h - pad - ((scores[i] == null ? 0 : scores[i]) / max) * (h - pad * 2)
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
    const todayStr = state.w && state.w.daily && state.w.daily.time[0];
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
  loadNearbyPoints(lat, lon);
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

// Open-Meteo 地理编码：支持地级市（不含大部分区县）
async function openMeteoSearch(name) {
  try {
    const j = await fetchJsonRetry(`${GEO_URL}?name=${encodeURIComponent(name)}&count=5&language=zh&format=json`);
    return ((j && j.results) || []).map(r => ({
      name: r.name,
      lat: r.latitude,
      lon: r.longitude,
      admin1: r.admin1 || '',
      country: r.country || '中国',
      sub: [r.admin1, r.country].filter(Boolean).join(' · '),
      source: 'openmeteo'
    }));
  } catch (e) {
    return [];
  }
}

// Photon 地理编码：支持区县/镇街（如「金水区」「海淀区」）
// lang=default 强制返回本地语言名称，避免浏览器 Accept-Language 头导致返回英文拼音
async function photonSearch(name) {
  try {
    const url = `${PHOTON_URL}?q=${encodeURIComponent(name)}&limit=6&lang=default`;
    const j = await fetchJsonRetry(url);
    return (j.features || [])
      .filter(f => {
        const p = f.properties || {};
        return String(p.countrycode || '').toUpperCase() === 'CN' || /中国/.test(p.country || '');
      })
      .filter(f => {
        // 只保留地名类结果，过滤公园/学校等兴趣点
        const k = (f.properties || {}).osm_key || '';
        return ['place', 'locality', 'city', 'town', 'village', 'suburb', 'district', 'borough', 'municipality'].includes(k);
      })
      .map(f => {
        const p = f.properties || {};
        const [lon, lat] = f.geometry.coordinates;
        const admin1 = p.state || p.city || p.country || '';
        const sub = [p.city, p.state, p.district].filter(x => x && x !== p.name).join(' · ');
        return {
          name: p.name,
          lat, lon,
          admin1,
          country: p.country || '中国',
          sub: sub || (p.country || '中国'),
          source: 'photon'
        };
      });
  } catch (e) {
    return [];
  }
}

// 从「郑州金水区」「河南滑县」这类带省市前缀的查询中生成候选搜索词：
// 完整查询 + 末尾的区县形子串。规则：
// - 末尾 3 字以 区/县/旗/盟 结尾 → 可能是「金水区」这类区县名，加入
// - 末尾 2 字以 县/旗/盟 结尾 → 可能是「滑县」这类两字县名，加入
//   （此时若 3 字尾巴以它结尾，说明 3 字尾巴是冗余前缀如「南滑县」，剔除）
function searchQueries(q) {
  const cands = [q];
  const t3 = q.slice(-3), t2 = q.slice(-2);
  if (q.length > 3 && /(?:区|县|旗|盟)$/.test(t3)) cands.push(t3);
  if (q.length > 2 && /(?:县|旗|盟)$/.test(t2)) {
    cands.push(t2);
    if (q.length > 3 && t3.endsWith(t2)) cands.splice(cands.indexOf(t3), 1);
  }
  return [...new Set(cands)];
}

// 结果排序：中文名优先于拼音、名称与查询词越吻合越靠前、查询带区/县后缀时优先匹配区县
function rankResult(r, q, cores) {
  let s = 0;
  if (/[\u4e00-\u9fff]/.test(r.name)) s += 3;
  if (r.name === q) s += 4;
  if (r.name.startsWith(q)) s += 2;
  // 与候选区县名吻合（如「金水区」「滑县」）
  let core = null;
  if (cores) for (const c of cores) {
    if (r.name === c || r.name.endsWith(c)) { s += 4; core = c; break; }
  }
  if (/[区县市镇]$/.test(q) && /[区县市镇]$/.test(r.name)) s += 2;
  if (r.admin1) s += 1;
  // 查询带省市前缀（如「郑州金水区」的「郑州」）时，结果所属区域包含该前缀优先
  if (core) {
    const head = q.slice(0, -core.length).trim();
    if (head) {
      const scope = [r.admin1, r.sub].filter(Boolean).join(' ');
      if (scope.includes(head)) s += 5;
    }
  }
  return s;
}

// 合并两个数据源：Open-Meteo（城市）+ Photon（区县），按 名称+坐标 去重后按相关度排序
async function searchCity(name) {
  const q = String(name).trim();
  const cands = searchQueries(q);
  const cores = cands.slice(1);  // 末尾区县形子串（用于排序加权）
  const [geo, photon] = await Promise.all([
    Promise.all(cands.map(openMeteoSearch)).then(xs => xs.flat()),
    Promise.all(cands.map(photonSearch)).then(xs => xs.flat())
  ]);
  const seen = new Set();
  const out = [];
  for (const r of [...geo, ...photon]) {
    const key = r.name.replace(/[市区县]$/, '') + '|' + r.lat.toFixed(2) + '|' + r.lon.toFixed(2);
    if (seen.has(key)) continue;
    seen.add(key);
    r.rank = rankResult(r, q, cores);
    out.push(r);
  }
  return out.sort((a, b) => b.rank - a.rank);
}

/* ---------- 搜索建议下拉 ---------- */

let suggestResults = [];
let suggestActive = -1;
let suggestTimer = null;

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderSuggestions() {
  const box = $('suggestBox');
  if (!suggestResults.length) { hideSuggest(); return; }
  box.innerHTML = suggestResults.map((r, i) =>
    `<div class="suggest-item${i === suggestActive ? ' active' : ''}" data-i="${i}" role="option">` +
    `<span class="sg-name">${esc(r.name)}</span>` +
    `<span class="sg-sub">${esc(r.sub)}</span>` +
    `</div>`).join('');
  box.classList.remove('hidden');
}

function hideSuggest() {
  const box = $('suggestBox');
  box.classList.add('hidden');
  box.innerHTML = '';
  suggestResults = [];
  suggestActive = -1;
}

function chooseSuggest(i) {
  const r = suggestResults[i];
  if (!r) return;
  hideSuggest();
  $('cityInput').value = '';
  mapFocus = true;  // 搜索区县后聚焦到该地附近 200km
  loadCity(r.lat, r.lon, r.name, provinceKeyOf(r.admin1) || undefined);
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

// 省会/首府城市：各省级行政区点位列表的第一项
const PROVINCE_CAPITALS = new Set(
  Object.keys(PROVINCE_CITIES)
    .map(p => PROVINCE_CITIES[p][0] && PROVINCE_CITIES[p][0].name)
    .filter(Boolean)
);

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

// 地图各图层数据缓存：全国主城市点位、当前省份其余城市点位（供全国视野恢复显示）
let mainCityPointsData = [];
let provincePointsData = [];

async function fetchCityScores(cities) {
  const out = [];
  const CONC = 8;
  for (let i = 0; i < cities.length; i += CONC) {
    const batch = cities.slice(i, i + CONC).map(async c => ({ name: c.name, score: await fetchCityIndex(c) }));
    out.push(...await Promise.all(batch));
  }
  return out;
}

// 拉取当前省份各城市指数并在地图上显示（颜色随指数的小点）
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
  provincePointsData = data.map(d => {
    const c = cities.find(x => x.name === d.name);
    return {
      name: d.name, score: d.score, value: [c.lng, c.lat, d.score],
      label: {
        backgroundColor: scoreColorA(d.score, 0.92),
        borderColor: scoreColorA(d.score, 0.7),
        borderWidth: 1,
        padding: [2, 5],
        borderRadius: 5,
        color: labelTextColor(d.score)
      }
    };
  });
  // 聚焦模式下只显示搜索地和附近 200km 城市指数，省份其余城市点位隐藏，全国视野时恢复
  mapChart.setOption({ series: [{}, {}, {}, {}, { data: mapFocus ? [] : provincePointsData }] });
}

// 球面距离（km）
function distKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const rad = d => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const nearbyCache = new Map();
let nearbyPointsData = [];

// 拉取当前城市附近 200km 内（含跨省）各城市的晚霞指数，聚焦模式下显示数值
async function loadNearbyPoints(lat, lon) {
  if (!mapChart) return;
  const key = lat.toFixed(1) + ',' + lon.toFixed(1);
  let data = nearbyCache.get(key);
  if (!data) {
    const all = [];
    const seen = new Set();
    Object.keys(PROVINCE_CITIES).forEach(p => {
      PROVINCE_CITIES[p].forEach(c => {
        if (seen.has(c.name)) return;
        seen.add(c.name);
        all.push(c);
      });
    });
    const near = all.filter(c => c.name !== state.city && distKm(lat, lon, c.lat, c.lng) <= 200);
    const scores = await fetchCityScores(near);
    data = scores.filter(d => d.score != null).map(d => {
      const c = all.find(x => x.name === d.name);
      return {
        name: d.name, score: d.score, value: [c.lng, c.lat, d.score],
        label: {
          backgroundColor: scoreColorA(d.score, 0.92),
          borderColor: scoreColorA(d.score, 0.7),
          borderWidth: 1,
          padding: [1, 5],
          borderRadius: 4,
          color: labelTextColor(d.score)
        }
      };
    });
    nearbyCache.set(key, data);
  }
  nearbyPointsData = data;
  if (mapChart && mapFocus) {
    mapChart.setOption({ series: [{}, {}, {}, {}, {}, { data: data }] });
  }
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
  if (mapFocus) {
    setFocusGeo(lat, lon);
    $('mapToggle').textContent = '查看全国';
  }
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
    series: [
      { pointSize: 26, blurSize: 34 },
      { label: { show: false }, data: [] },  // 聚焦时只显示搜索地和附近 200km 城市，隐藏全国城市散点
      {}, {},
      { label: { show: false }, data: [] },  // 省份其余城市点位同样隐藏
      { data: nearbyPointsData }             // 附近 200km 城市点位（含指数）
    ]
  });
  updateRangeCircle(lon, lat);
}

// 展开为全国视野
function showFullMap() {
  if (!mapChart) return;
  mapFocus = false;
  mapChart.setOption({
    geo: { center: MAP_CENTER, zoom: FULL_ZOOM },
    series: [
      { pointSize: 18, blurSize: 26 },
      { label: { show: true }, data: mainCityPointsData },
      {}, {},
      { label: { show: true }, data: provincePointsData },
      { data: [] }   // 全国视野下清空附近 200km 点位
    ]
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

// 指数 → 颜色：与热力区域同一套黄→橙→红渐变，数值越高越红（可指定透明度）
function scoreColorA(score, a) {
  if (score == null) return `rgba(160,165,185,${a})`;
  const t = Math.max(0, Math.min(1, score / 100));
  const stops = [[255, 241, 118], [255, 167, 38], [255, 82, 82]];
  const seg = Math.min(2, Math.floor(t * 2));
  const f = t * 2 - seg;
  const c1 = stops[seg], c2 = stops[Math.min(2, seg + 1)];
  const r = Math.round(c1[0] + (c2[0] - c1[0]) * f);
  const g = Math.round(c1[1] + (c2[1] - c1[1]) * f);
  const b = Math.round(c1[2] + (c2[2] - c1[2]) * f);
  return `rgba(${r},${g},${b},${a})`;
}

function scoreColor(score) {
  return scoreColorA(score, 1);
}

// 标签文字颜色：底色偏红/橙时用白字，底色偏黄时用深棕字
function labelTextColor(score) {
  if (score == null) return '#5a5f75';
  return score >= 70 ? '#ffffff' : '#5c3a10';
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
    // 全国主城市点位（全国视野下显示，聚焦模式隐藏）
    mainCityPointsData = data.map(d => {
      const c = MAP_CITIES.find(x => x.name === d.name);
      return {
        name: d.name, score: d.score, value: [c.lng, c.lat, d.score],
        label: {
          backgroundColor: d.score == null ? 'rgba(255,255,255,0.88)' : scoreColorA(d.score, 0.92),
          borderColor: d.score == null ? 'rgba(130,135,155,0.5)' : scoreColorA(d.score, 0.7),
          borderWidth: 1,
          padding: [2, 6],
          borderRadius: 5,
          color: labelTextColor(d.score)
        }
      };
    });
    chart.setOption({
      backgroundColor: '#e9edf5',
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
        textStyle: { color: '#5a5a72', fontSize: 11 },
        inRange: { color: ['rgba(255,232,110,0.55)', 'rgba(255,170,40,0.6)', 'rgba(255,66,66,0.65)'] },
        backgroundColor: 'rgba(20,16,45,0.6)',
        borderColor: 'rgba(255,255,255,0.18)',
        borderWidth: 1,
        padding: 8
      },
      geo: {
        map: 'china',
        roam: true,
        zoom: 1.15,
        itemStyle: { areaColor: '#dde2ee', borderColor: '#98a1ba', borderWidth: 1 },
        emphasis: { itemStyle: { areaColor: '#f7dccb' }, label: { show: false } }
      },
      series: [
        {
          type: 'heatmap',
          coordinateSystem: 'geo',
          zlevel: 1,
          pointSize: 22,
          blurSize: 30,
          data: heatData
        },
        {
          type: 'scatter',
          coordinateSystem: 'geo',
          zlevel: 2,
          data: mainCityPointsData,
          symbolSize: val => (val[2] == null ? 0 : 8 + (val[2] / 100) * 10),
          itemStyle: { color: p => scoreColor(p.data.score), borderColor: '#ffffff', borderWidth: 1.5 },
          label: {
            show: true,
            position: 'right',
            formatter: p => {
              const s = p.data.score;
              if (s == null) return '';
              // 省会/首府城市始终显示数值，其余城市指数 ≥ 60 才显示
              if (s >= 60 || PROVINCE_CAPITALS.has(p.name)) return p.name + ' ' + s;
              return '';
            },
            color: '#5c3a10',
            fontSize: 11,
            fontWeight: 700
          },
          emphasis: {
            scale: 1.6,
            label: {
              show: true,
              position: 'right',
              formatter: p => p.name + ' ' + (p.data.score == null ? '--' : p.data.score),
              color: p => labelTextColor(p.data.score),
              fontSize: 13,
              fontWeight: 'bold',
              backgroundColor: p => scoreColorA(p.data.score, 0.96),
              borderColor: p => scoreColorA(p.data.score, 0.8),
              borderWidth: 1,
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
            color: '#0e6f9e',
            fontSize: 11,
            fontWeight: 600,
            backgroundColor: 'rgba(255,255,255,0.88)',
            padding: [2, 6],
            borderRadius: 4
          },
          data: []
        },
        {
          // 当前城市所在省份的各城市点位（颜色随指数，带指数）
          type: 'scatter',
          coordinateSystem: 'geo',
          zlevel: 2,
          symbolSize: val => (val[2] == null ? 0 : 6 + (val[2] / 100) * 7),
          itemStyle: { color: p => scoreColor(p.data.score), borderColor: '#ffffff', borderWidth: 1.2 },
          label: {
            show: true,
            position: 'right',
            formatter: p => (p.data.score != null && p.data.score >= 60) ? p.name + ' ' + p.data.score : '',
            color: '#7a5420',
            fontSize: 10,
            fontWeight: 600
          },
          emphasis: {
            scale: 1.5,
            label: {
              show: true,
              position: 'right',
              formatter: p => p.name + ' ' + (p.data.score == null ? '--' : p.data.score),
              color: p => labelTextColor(p.data.score),
              fontSize: 12,
              fontWeight: 'bold',
              backgroundColor: p => scoreColorA(p.data.score, 0.96),
              borderColor: p => scoreColorA(p.data.score, 0.8),
              borderWidth: 1,
              padding: [3, 6],
              borderRadius: 5
            }
          },
          data: []
        },
        {
          // 当前城市附近 200km 内的城市：聚焦模式下统一显示晚霞数值（含跨省）
          type: 'scatter',
          coordinateSystem: 'geo',
          zlevel: 2,
          symbolSize: val => (val[2] == null ? 0 : 7 + (val[2] / 100) * 8),
          itemStyle: { color: p => scoreColor(p.data.score), borderColor: '#ffffff', borderWidth: 1.3 },
          label: {
            show: true,
            position: 'right',
            distance: 4,
            formatter: p => p.name + ' ' + p.data.score,
            color: p => labelTextColor(p.data.score),
            fontSize: 10,
            fontWeight: 600,
            backgroundColor: p => scoreColorA(p.data.score, 0.92),
            borderColor: p => scoreColorA(p.data.score, 0.7),
            borderWidth: 1,
            padding: [1, 5],
            borderRadius: 4
          },
          emphasis: { disabled: true },
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
        if (pc) { loadCity(pc.lat, pc.lng, pc.name, key); return; }
      }
      // 附近 200km 城市点位（含跨省）也可点击切换查询
      const nc = nearbyPointsData.find(x => x.name === p.name);
      if (nc) loadCity(nc.value[1], nc.value[0], nc.name);
    });
    // 拖拽/缩放时保持 200km 圆环贴合实际距离
    chart.on('georoam', () => updateRangeCircle(state.lat, state.lon));
    $('mapToggle').addEventListener('click', () => {
      if (mapFocus) showFullMap(); else showFocusMap();
    });
    window.addEventListener('resize', () => chart.resize());
    showFocusMap();
    loadProvincePoints();
    loadNearbyPoints(state.lat, state.lon);
  } catch (e) {
    console.warn('地图初始化失败：', e);
    note.textContent = '地图加载失败，请检查网络后刷新页面';
  }
}

/* ---------- 照片分享墙 ---------- */

// ==== 分享墙后端配置（LeanCloud，免费）====
// 1. 到 https://www.leancloud.cn 注册账号并创建应用（国内版）
// 2. 进入 控制台 → 设置 → 应用凭证，复制 AppID / AppKey / 服务器地址
// 3. 填入下面三项后保存，打开网页照片即全网共享
// 4. （可选）控制台 → 设置 → 安全中心 → 配置安全域名，填入你的 GitHub Pages 域名
// 未填写配置时自动回退为「仅本浏览器可见」。
const SHARE_CONFIG = {
  appId: '',      // 应用凭证 → AppID
  appKey: '',     // 应用凭证 → AppKey
  serverURL: ''   // 应用凭证 → 服务器地址（形如 https://xxxx.api.lncldglobal.com）
};
const SHARE_CLASS = 'SharePhoto';
const GALLERY_KEY = 'fc_gallery_v1';
const GALLERY_MAX = 30;
const SHARE_OWNER_KEY = 'fc_share_owner_v1';

const isRemoteShare = () => !!(SHARE_CONFIG.appId && SHARE_CONFIG.serverURL);

// 本机固定的匿名所有者标识（用于删除自己上传的照片）
function myOwnerId() {
  let o = localStorage.getItem(SHARE_OWNER_KEY);
  if (!o) {
    o = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    localStorage.setItem(SHARE_OWNER_KEY, o);
  }
  return o;
}

function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// 「2026-10-07」→「2026/10/7」
function fmtDate(v) {
  if (!v) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  if (m) return m[1] + '/' + Number(m[2]) + '/' + Number(m[3]);
  return String(v);
}

/* ---- LeanCloud REST 接口 ---- */

function lcHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-LC-Id': SHARE_CONFIG.appId,
    'X-LC-Key': SHARE_CONFIG.appKey
  };
}

// 读取分享墙（最新在前）
async function lcQuery() {
  const res = await fetch(`${SHARE_CONFIG.serverURL}/1.1/classes/${SHARE_CLASS}?order=-createdAt&limit=${GALLERY_MAX}`, { headers: lcHeaders() });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  return (j.results || []).map(o => ({
    id: o.objectId,
    dataURL: o.image,
    name: o.name || '',
    date: o.date || o.createdAt,
    ts: Date.parse(o.createdAt) || 0,
    owner: o.owner || ''
  }));
}

async function lcCreate(obj) {
  const res = await fetch(`${SHARE_CONFIG.serverURL}/1.1/classes/${SHARE_CLASS}`, {
    method: 'POST', headers: lcHeaders(), body: JSON.stringify(obj)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function lcDelete(objectId) {
  const res = await fetch(`${SHARE_CONFIG.serverURL}/1.1/classes/${SHARE_CLASS}/${objectId}`, {
    method: 'DELETE', headers: lcHeaders()
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
}

/* ---- 本地回退存储 ---- */

function getLocalGallery() {
  try { return JSON.parse(localStorage.getItem(GALLERY_KEY)) || []; } catch (e) { return []; }
}

function saveLocalGallery(list) {
  try {
    localStorage.setItem(GALLERY_KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    alert('本地存储空间不足，请先删除部分旧照片再分享。');
    return false;
  }
}

/* ---- 图片处理 ---- */

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

// 在照片正中间绘制署名水印（名字或匿名 + 日期）
function applyWatermark(dataURL, name, dateStr) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const W = canvas.width, H = canvas.height;
      const bandH = Math.max(46, Math.round(H * 0.085));
      const y = Math.round(H / 2 - bandH / 2);
      // 正中间的半透明条带
      ctx.fillStyle = 'rgba(0,0,0,0.42)';
      ctx.fillRect(0, y, W, bandH);
      // 条带上下的细线点缀
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(0, y, W, 2);
      ctx.fillRect(0, y + bandH - 2, W, 2);
      // 署名文字
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = 8;
      ctx.font = `bold ${Math.max(20, Math.round(W * 0.05))}px "PingFang SC","Microsoft YaHei",sans-serif`;
      ctx.fillText((name || '匿名') + ' · ' + fmtDate(dateStr), W / 2, y + bandH / 2);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.src = dataURL;
  });
}

/* ---- 渲染 ---- */

let shareCache = [];  // 远程分享墙缓存

// 加载并渲染分享墙（远程优先，失败回退本地）
async function loadGallery() {
  const grid = $('galleryGrid');
  const empty = $('galleryEmpty');
  const sub = $('gallerySub');
  if (isRemoteShare()) {
    sub.textContent = '晒出你拍到的霞光 · 照片全网共享，正中带署名水印，禁止下载';
    try {
      shareCache = await lcQuery();
      renderGallery(shareCache);
    } catch (e) {
      console.error('分享墙远程加载失败，回退本地：', e);
      sub.textContent = '晒出你拍到的霞光 · 正中带署名水印，禁止下载（远程不可用，当前仅本浏览器可见）';
      renderGallery(getLocalGallery());
    }
  } else {
    sub.textContent = '晒出你拍到的霞光 · 正中带署名水印，禁止下载（未配置后端，当前仅本浏览器可见）';
    renderGallery(getLocalGallery());
  }
}

function renderGallery(list) {
  const grid = $('galleryGrid');
  const empty = $('galleryEmpty');
  grid.innerHTML = '';
  empty.classList.toggle('hidden', list.length > 0);
  // 按发布日期倒序，最新的排最前
  const sorted = [...list].sort((a, b) => (b.ts || b.id || 0) - (a.ts || a.id || 0));
  sorted.forEach(item => {
    const card = document.createElement('figure');
    card.className = 'gallery-item';
    // 每张照片轻微随机倾角，营造错落悬浮感
    card.style.setProperty('--tilt', (Math.random() * 2.4 - 1.2).toFixed(2) + 'deg');
    card.oncontextmenu = e => e.preventDefault();

    const img = document.createElement('img');
    img.src = item.dataURL;
    img.alt = item.name || '匿名';
    img.draggable = false;

    const fig = document.createElement('figcaption');
    fig.textContent = (item.name || '匿名') + ' · ' + fmtDate(item.date);

    // 禁止下载：仅自己的照片显示删除按钮（远程），本地模式全部可删
    const canDel = !isRemoteShare() || (item.owner && item.owner === myOwnerId());
    if (canDel) {
      const del = document.createElement('button');
      del.className = 'gallery-del';
      del.textContent = '删除';
      del.onclick = async () => {
        if (isRemoteShare()) {
          try {
            await lcDelete(item.id);
            shareCache = shareCache.filter(x => x.id !== item.id);
            renderGallery(shareCache);
          } catch (e) { alert('删除失败，请稍后再试。'); }
        } else {
          const next = getLocalGallery().filter(x => x.id !== item.id);
          if (saveLocalGallery(next)) renderGallery(next);
        }
      };
      const ops = document.createElement('div');
      ops.className = 'gallery-ops';
      ops.append(del);
      card.append(img, fig, ops);
    } else {
      card.append(img, fig);
    }
    grid.appendChild(card);
  });
}

async function handleGalleryFile(file) {
  const btn = $('gallerySubmit');
  try {
    const raw = await compressImage(file);
    const name = ($('galleryName').value || '').trim();
    const date = todayISO();
    const ts = Date.now();
    const watermarked = await applyWatermark(raw, name, date);
    btn.disabled = true;
    btn.textContent = '上传中…';
    if (isRemoteShare()) {
      const created = await lcCreate({ image: watermarked, name, date, owner: myOwnerId() });
      shareCache.unshift({ id: created.objectId, dataURL: watermarked, name, date, ts, owner: myOwnerId() });
      shareCache = shareCache.slice(0, GALLERY_MAX);
      renderGallery(shareCache);
    } else {
      const list = getLocalGallery();
      list.unshift({ id: ts, ts, dataURL: watermarked, name, date, owner: myOwnerId() });
      while (list.length > GALLERY_MAX) list.pop();
      if (!saveLocalGallery(list)) return;
      renderGallery(list);
    }
    $('galleryName').value = '';
    $('galleryFile').value = '';
    btn.textContent = '分享';
    $('galleryGrid').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    console.error('上传失败：', e);
    btn.disabled = !$('galleryFile').files[0];
    btn.textContent = '分享';
    alert('上传失败，请检查网络后重试。');
  }
}

/* ---------- 事件绑定 ---------- */

function init() {
  renderStars();
  renderGaugeTicks();

  $('searchBtn').addEventListener('click', async () => {
    const name = $('cityInput').value.trim();
    if (!name) return;
    hideSuggest();
    const results = await searchCity(name);
    if (!results.length) {
      $('cityName').textContent = state.city;
      $('errorMsg').textContent = `未找到城市或区县「${name}」，换个关键词试试。`;
      $('errorBox').classList.remove('hidden');
      return;
    }
    const hit = results[0];
    mapFocus = true;  // 搜索后聚焦到该地附近 200km
    loadCity(hit.lat, hit.lon, hit.name, provinceKeyOf(hit.admin1) || undefined);
  });

  // 输入时防抖搜索，展示城市/区县建议
  $('cityInput').addEventListener('input', () => {
    clearTimeout(suggestTimer);
    const q = $('cityInput').value.trim();
    if (q.length < 2) { hideSuggest(); return; }
    suggestTimer = setTimeout(async () => {
      suggestResults = await searchCity(q);
      suggestActive = -1;
      renderSuggestions();
    }, 280);
  });

  $('cityInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      // 有高亮项时选中它；否则走查询按钮（重新搜索，避免用到过期的建议列表）
      if (suggestActive >= 0 && suggestResults.length) { chooseSuggest(suggestActive); return; }
      $('searchBtn').click();
      return;
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!suggestResults.length) return;
      suggestActive = (suggestActive + 1) % suggestResults.length;
      renderSuggestions();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!suggestResults.length) return;
      suggestActive = (suggestActive - 1 + suggestResults.length) % suggestResults.length;
      renderSuggestions();
    } else if (e.key === 'Escape') {
      hideSuggest();
    }
  });

  $('suggestBox').addEventListener('mousedown', e => {
    const item = e.target.closest('.suggest-item');
    if (item) chooseSuggest(Number(item.dataset.i));
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.search-wrap')) hideSuggest();
  });

  $('locateBtn').addEventListener('click', locate);
  $('retryBtn').addEventListener('click', loadData);

  // 照片分享墙
  loadGallery();
  $('galleryGrid').addEventListener('contextmenu', e => e.preventDefault());
  $('galleryFile').addEventListener('change', e => {
    $('gallerySubmit').disabled = !e.target.files[0];
  });
  $('gallerySubmit').addEventListener('click', () => {
    const f = $('galleryFile').files[0];
    if (f) handleGalleryFile(f);
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
