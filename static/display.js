/* ConOps wall display. Reads the same /api/summary as the main page,
   refreshes itself, and is meant to be left open fullscreen.

   Always English: staff on shift are international, and the board should not
   change language because a visitor switched it on the public site. */

EFW_I18N.force('en');

const REFRESH_MS = 5 * 60 * 1000;
const HOURS_AHEAD = 24;
/* A little of the day that has gone by, drawn grey behind the now line, so the
   shift can see what the weather has been doing as well as where it is going. */
const PAST_CONTEXT_HOURS = 4;
/* Nobody stands at a wall board. Whatever hour someone picked, it goes back to
   live conditions on its own rather than sitting on a forecast all evening. */
const PICK_TIMEOUT_MS = 90 * 1000;

/* Most boards are a screen on a wall with no input device anywhere near them.
   There, a bar that reacts to a click is only a way for a stray cursor -- or a
   passing shoulder against a panel -- to leave the board sitting on a forecast,
   and a "tap a bar" hint is an instruction nobody can follow. So the board is a
   plain monitor by default and interaction is opt-in per URL:

       /display?touch

   for the one screen at the desk that really is a touchscreen. */
const TOUCH = new URLSearchParams(location.search).has('touch');

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 0, u = '') => (v === null || v === undefined ? '–' : `${Number(v).toFixed(d)}${u}`);

let latest = null; // last good payload, so a redraw needs no fetch
let shown = []; // the hours currently on the chart
let picked = null; // ISO time of the bar someone clicked, if any
let pickTimer = null;

/* A stale cached script must never blank the board -- degrade one field. */
function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
  else console.warn('EFW display: missing element', id);
}

/** 24-hour clock with the am/pm reading alongside, e.g. "14:00 (2 PM)". */
function clockPair(value) {
  const at = new Date(value);
  const h24 = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const h12 = at
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    .replace(':00', '');
  return `${h24} (${h12})`;
}

const clock24 = (value) =>
  new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/* The clock ticks independently so the display never looks frozen, even if a
   refresh fails or DWD is briefly unreachable. */
function tick() {
  setText(
    'clock',
    new Date().toLocaleTimeString('en-GB', {
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  );
}
setInterval(tick, 1000);
tick();

/** Best and worst stretches, as bands drawn under the bars they describe. */
function chartRanges(data) {
  const ranges = [];
  for (const [window, kind, mark, word] of [
    [data.best_window, 'good', '✅', 'BEST'],
    [data.worst_window, 'bad', '⛔', 'AVOID'],
  ]) {
    if (!window) continue;
    const full = `${clockPair(window.start)} – ${clockPair(window.end)}`;
    const short = `${clock24(window.start)}–${clock24(window.end)}`;
    ranges.push({
      start: window.start,
      end: window.end,
      kind,
      // Longest first: a two-hour stretch is a sliver of a 24-hour chart, so the
      // wording steps down until it fits and otherwise moves out beside the band.
      labels: [`${mark} ${word} ${full}`, `${mark} ${word} ${short}`, `${mark} ${word}`, mark],
      outsideLabel: `${mark} ${word} ${short}`,
      title: `${word} ${full}`,
    });
  }
  return ranges;
}

/* --------------------------------------------------------------- alerts bar */

/* One chip. `tone` carries the colour the chip is drawn in, which for a DWD
   warning is DWD's own -- their severity palette is what staff already read on
   the official app. */
function alertChip(mark, title, detail, tone, extraClass) {
  const chip = document.createElement('div');
  chip.className = extraClass ? `alert ${extraClass}` : 'alert';
  if (tone) {
    chip.style.setProperty('--tone', tone);
    chip.style.setProperty('--alert-ink', EFW.contrastText(tone));
  }

  const head = document.createElement('span');
  head.className = 'alert-head';
  head.textContent = `${mark} ${title}`;
  chip.append(head);

  if (detail) {
    const note = document.createElement('span');
    note.className = 'alert-detail';
    note.textContent = detail;
    chip.append(note);
  }
  return chip;
}

/** "until 20:00", or nothing at all if DWD did not say when it ends. */
function warningWindow(warning) {
  if (!warning.end) return '';
  return `until ${clock24(warning.end)}`;
}

/* Official DWD warnings first, then pollen. Pollen only speaks up at "high" --
   DWD's own threshold for heavy exposure -- because grass counts sit above the
   moderate line for most of a northern-German summer, and a strip that is lit
   every day is a strip nobody reads. */
function renderAlerts(data) {
  const host = $('alerts');
  if (!host) return;
  host.innerHTML = '';

  for (const warning of data.warnings || []) {
    host.append(
      alertChip(
        warning.advance ? '👁️' : '⚠️',
        warning.advance ? `Advance notice: ${warning.event_en}` : warning.event_en,
        [warning.region, warningWindow(warning)].filter(Boolean).join(' · '),
        warning.color,
        warning.advance ? 'is-advance' : ''
      )
    );
  }

  for (const reading of data.pollen || []) {
    if (!reading.warn) continue;
    host.append(
      alertChip(
        '🤧',
        `Pollen: ${EFW_I18N.T(`pollen.${reading.key}`)} ${EFW_I18N.T(
          `pollen.level.${reading.level}`
        ).toLowerCase()}`,
        `${fmt(reading.value, 0)} grains/m³ · DWD forecast, not a measurement`,
        reading.color,
        'is-pollen'
      )
    );
  }

  host.hidden = host.childElementCount === 0;
}

/* ---------------------------------------------------------- conditions tile */

function fillConditions(items) {
  const host = $('conditions');
  host.innerHTML = '';

  for (const [key, value] of items) {
    const item = document.createElement('div');
    item.className = 'item';
    const k = document.createElement('div');
    k.className = 'k';
    k.textContent = key;
    const v = document.createElement('div');
    v.className = 'v';
    v.textContent = value;
    item.append(k, v);
    host.append(item);
  }
}

function observedItems(current, fsi) {
  return [
    ['Conditions', `${current.weather.icon || ''} ${current.weather.text || '–'}`.trim()],
    ['Temperature', fmt(current.temperature, 1, ' °C')],
    // Named for what they are: both read below the air temperature, so
    // "Feels like" on either of them looked like a fault on a muggy evening.
    ['Wet-bulb', fmt(fsi?.wetbulb, 1, ' °C')],
    ['Dew point', fmt(fsi?.dewpoint, 1, ' °C')],
    ['Humidity', fmt(current.humidity, 0, ' %')],
    ['Wind', fmt(current.wind_speed_kmh, 0, ' km/h')],
    ['Gusts', fmt(current.wind_gust_kmh, 0, ' km/h')],
    ['Rain (1 h)', fmt(current.precipitation, 1, ' mm')],
  ];
}

function forecastItems(entry) {
  return [
    ['Conditions', `${entry.weather?.icon || ''} ${entry.weather?.text || '–'}`.trim()],
    ['Index', `${entry.score.toFixed(1)} ${entry.label || ''}`.trim()],
    ['Temperature', fmt(entry.temperature, 1, ' °C')],
    ['Wet-bulb', fmt(entry.wetbulb, 1, ' °C')],
    ['Dew point', fmt(entry.dewpoint, 1, ' °C')],
    ['Humidity', fmt(entry.humidity, 0, ' %')],
    ['Wind', fmt(entry.wind_speed_kmh, 0, ' km/h')],
    ['Gusts', fmt(entry.wind_gust_kmh, 0, ' km/h')],
    ['Rain', `${fmt(entry.precipitation, 1, ' mm')} · ${fmt(entry.precipitation_prob, 0, ' %')}`],
  ];
}

function setHeading(title, hint) {
  const host = $('conditions-head');
  if (!host) return;
  host.textContent = title;
  if (!hint) return;
  const note = document.createElement('span');
  note.className = 'hint';
  note.textContent = ` — ${hint}`;
  host.append(note);
}

/** Show the observation, or the hour of whichever bar was clicked. */
function showConditions() {
  const tile = document.querySelector('.conditions-tile');
  const entry = picked ? shown.find((item) => item.time === picked) : null;
  tile?.classList.toggle('is-picked', Boolean(entry));

  if (entry) {
    setHeading(`At ${clockPair(entry.time)}`, 'forecast, back to live shortly');
    fillConditions(forecastItems(entry));
    return;
  }

  setHeading('Right now');
  if (latest?.current) fillConditions(observedItems(latest.current, latest.fsi));
}

function markSelection() {
  for (const column of $('timeline').querySelectorAll('.hour')) {
    column.classList.toggle('is-selected', column.dataset.time === picked);
  }
}

function pickHour(time) {
  picked = picked === time ? null : time; // clicking the same bar goes back to now
  clearTimeout(pickTimer);
  if (picked) pickTimer = setTimeout(() => pickHour(picked), PICK_TIMEOUT_MS);
  markSelection();
  showConditions();
}

/* --------------------------------------------------------------- the chart */

function drawTimeline() {
  if (!latest) return;
  shown = EFW.outlook(latest.fsi_series, HOURS_AHEAD, PAST_CONTEXT_HOURS);
  if (picked && !shown.some((entry) => entry.time === picked)) picked = null;

  EFW.renderStrip($('timeline'), shown, {
    labelEvery: 1,
    markNow: true,
    values: true,
    temperatures: true,
    selected: picked,
    // No handler means renderStrip leaves the columns inert: no tabindex, no
    // role="button", and .is-pickable off, so the hover and pointer styles go
    // with it. A monitor board gets bars that are only a picture.
    onSelect: TOUCH ? (entry) => pickHour(entry.time) : null,
    ranges: chartRanges(latest),
    // Also on the bars, not only in the strip above: the strip says a warning
    // is in force, the hatching says which hours it covers, and a shift
    // planning the next few hours needs the second as much as the first.
    warnings: EFW.warningRanges(latest.warnings),
  });
}

function renderLegend() {
  const host = $('legend');
  host.innerHTML = '';
  for (const { color, label } of EFW.bands()) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.setProperty('--c', color);
    const wrap = document.createElement('span');
    wrap.className = 'legend-item';
    wrap.append(chip, document.createTextNode(label));
    host.append(wrap);
  }
}

/* Purely cosmetic: one particular score earns a video. */
function renderEasterEgg(egg) {
  const panel = $('egg');
  if (!panel) return;
  const show = egg === 'ravi67';
  panel.hidden = !show;

  const video = $('egg-video');
  if (!video) return;
  if (show && video.paused) video.play().catch(() => {});
  if (!show) video.pause();
}

async function load() {
  try {
    const response = await fetch('/api/summary?lang=en', { cache: 'no-store' });
    if (!response.ok) throw new Error(`server ${response.status}`);
    const data = await response.json();

    latest = data;
    if (data.bands) EFW.setBands(data.bands);
    if (data.event?.name) setText('event-name', data.event.name);

    // Unhide before drawing: the chart measures itself as it draws, and inside
    // a hidden screen every one of those measurements comes back zero.
    $('screen').hidden = false;
    $('boot').hidden = true;

    const fsi = data.fsi;
    if (fsi) {
      // The tile is the score: its background is the band colour, with ink
      // picked for contrast so amber and green stay readable.
      const tile = $('score-tile');
      tile?.style.setProperty('--fsi', fsi.color);
      tile?.style.setProperty('--ink', EFW.contrastText(fsi.color));
      setText('score', fsi.score.toFixed(1));
      setText('label', fsi.label);
      setText('advice', fsi.advice);
    }

    renderAlerts(data);
    drawTimeline();
    renderLegend();
    showConditions();
    renderEasterEgg(fsi?.easter_egg);

    const observed = data.current ? new Date(data.current.time_local) : null;
    const parts = [];
    if (observed) parts.push(`Observed ${clockPair(observed)}`);
    parts.push(`updated ${clockPair(new Date())}`);
    if (data.degraded.length) parts.push(`⚠️ ${data.degraded.join(', ')}`);
    setText('foot-left', parts.join(' · '));
    $('foot-left').className = data.degraded.length ? 'stale' : '';
  } catch (error) {
    // Keep the last good screen up rather than blanking the display; only the
    // footer admits that the data has stopped updating.
    console.error('EFW display refresh failed', error);
    if ($('screen')?.hidden !== false) {
      setText('boot', `Could not load weather data: ${error.message}. Retrying…`);
    } else {
      setText('foot-left', `⚠️ Update failed at ${clockPair(new Date())} — showing last known data`);
      $('foot-left').className = 'stale';
    }
  }
}

/* Bar widths and which range labels still fit are measured at render time, so a
   resize -- or a board being switched between portrait and landscape -- has to
   redraw rather than reflow. */
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawTimeline, 200);
});

load();
setInterval(load, REFRESH_MS);
