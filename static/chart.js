/* Shared helpers for the hourly Fursuiting Index bars.
   Used by both the main page (app.js) and the ConOps display (display.js). */

window.EFW = (function () {
  const HOUR_MS = 3600 * 1000;

  /* Fallback scale, replaced by setBands() with the one the API publishes so
     the colours are defined in exactly one place (app/fsi.py). */
  let SCALE = [
    { min: 8.5, color: '#40ad3e', label: 'Excellent' },
    { min: 7.0, color: '#7cc243', label: 'Good' },
    { min: 5.0, color: '#ffd633', label: 'Fair' },
    { min: 3.0, color: '#ff8a3d', label: 'Poor' },
    { min: 0.0, color: '#f13ca3', label: 'Bad' },
  ];

  function setBands(bands) {
    if (Array.isArray(bands) && bands.length) SCALE = bands;
  }

  function scoreColor(score) {
    for (const band of SCALE) if (score >= band.min) return band.color;
    return SCALE[SCALE.length - 1].color;
  }

  function scoreLabel(score) {
    for (const band of SCALE) if (score >= band.min) return band.label;
    return SCALE[SCALE.length - 1].label;
  }

  function bands() {
    return SCALE;
  }

  const DARK_INK = '#10161d';

  /* #abc or #aabbcc, in either case, with or without the hash. Anything else --
     a named colour, an rgb() string, a field that never arrived -- is not
     something this file can measure, and it must say so rather than hand back
     numbers built out of NaN. */
  function normaliseHex(color) {
    if (typeof color !== 'string') return null;
    const hex = color.trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(hex)) return hex.replace(/./g, (c) => c + c);
    return /^[0-9a-f]{6}$/i.test(hex) ? hex : null;
  }

  /** Relative luminance per WCAG 2.1, or NaN if the colour cannot be read. */
  function luminance(color) {
    const hex = normaliseHex(color);
    if (!hex) return NaN;
    const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const [r, g, b] = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /**
   * Ink colour for a filled panel: whichever of near-black or white contrasts
   * better against the fill. The index colours run from hot pink through amber
   * to green, and amber in particular is unreadable under white text, so this
   * has to be measured rather than assumed.
   *
   * An unreadable colour returns dark ink, and the reason matters: every colour
   * on the index scale is a light one, so dark is the safe answer for all of
   * them. It used to be the opposite by accident -- luminance() came back NaN,
   * every comparison against NaN is false, and the function fell through to
   * white. That put white text on a pale panel, the one result this whole
   * function exists to prevent, and it did it silently.
   */
  function contrastText(color) {
    const l = luminance(color);
    if (!Number.isFinite(l)) {
      console.warn('EFW: cannot read panel colour %o, using dark ink', color);
      return DARK_INK;
    }
    const onDark = (l + 0.05) / 0.05; // contrast against #000
    const onLight = 1.05 / (l + 0.05); // contrast against #fff
    return onDark >= onLight ? DARK_INK : '#ffffff';
  }

  /** The start of the hour an ISO timestamp falls in, as epoch milliseconds. */
  function hourStart(iso) {
    return new Date(iso).setMinutes(0, 0, 0);
  }

  /** Longest run of missing hours worth drawing rather than skipping over. */
  const MAX_GAP_MS = 48 * HOUR_MS;

  /**
   * Fill any hour the payload skips with an empty slot.
   *
   * Every bar stands for the same span of time, so a missing hour has to keep
   * its place: dropped instead, 14:00 ends up drawn against 16:00 and the row
   * of hour labels below reads 12, 14, 16 at uneven distances -- the chart
   * quietly lies about how far apart the bars are, and the now line vanishes
   * whenever the hour it belongs in is the missing one. The day cards already
   * pad this way (fullDay in app.js); this makes every strip agree with them.
   */
  function contiguous(series) {
    const out = [];
    for (const entry of series) {
      const at = hourStart(entry.time);
      // Guard the loop on a bad timestamp: pad a gap, never a whole calendar.
      const previous = out.length ? hourStart(out[out.length - 1].time) : at;
      if (at - previous <= MAX_GAP_MS) {
        for (let slot = previous + HOUR_MS; slot < at; slot += HOUR_MS) {
          out.push({ time: new Date(slot).toISOString(), score: null });
        }
      }
      out.push(entry);
    }
    return out;
  }

  /**
   * Cut a scored series down to what a chart should show: a little of the day
   * that has already gone by, then the hours ahead.
   *
   * The API keeps the elapsed hours so they can be drawn greyed out behind the
   * "now" line, but they are context rather than forecast -- without a cap the
   * strip would have grown to 47 bars by late evening.
   *
   * Padded first, so `ahead` and `behind` count hours rather than however many
   * entries the payload happened to carry.
   */
  function outlook(series, ahead = 24, behind = 6) {
    if (!series || !series.length) return [];
    const hours = contiguous(series);
    const now = new Date().setMinutes(0, 0, 0);
    const first = hours.findIndex((entry) => hourStart(entry.time) >= now);
    if (first === -1) return hours.slice(-ahead); // every hour we have is past
    return hours.slice(Math.max(0, first - behind), first + ahead);
  }

  /**
   * Render a row of hourly bars into `host`.
   *
   * @param host      container element (cleared first)
   * @param series    [{time, score, color?, label?, temperature?, icon?}]
   * An entry with a null score is an hour we have no forecast for. It still
   * takes a slot -- a day the forecast only half covers has to draw bars the
   * same width as every other day, or two charts cannot be read against each
   * other -- but it draws as an empty outline and cannot be picked.
   *
   * @param options   labelEvery - show the hour under every Nth bar
   *                  markNow    - grey out elapsed hours and draw the now line
   *                  icons      - draw the weather icon above each bar
   *                  onSelect   - called with (entry, index) when a bar is picked
   *                  selected   - ISO time of the bar to show as picked
   *                  emptyLabel - tooltip for an hour with no forecast
   *                  temperatures - draw the rounded temperature inside each bar
   */
  function renderStrip(host, series, options = {}) {
    const {
      labelEvery = 3,
      markNow = false,
      icons = true,
      onSelect = null,
      selected = null,
      emptyLabel = 'No data',
      temperatures = false,
    } = options;
    host.innerHTML = '';
    if (!series || !series.length) {
      host.innerHTML = '<p class="empty">No forecast for this period.</p>';
      return;
    }

    // Emoji need roughly 22px to stay legible; below that thin them out rather
    // than letting them collide into a smear.
    const perBar = (host.clientWidth || 700) / series.length;
    const iconEvery = perBar >= 26 ? 1 : perBar >= 16 ? 2 : 3;
    host.classList.toggle('has-icons', icons);
    host.classList.toggle('is-pickable', Boolean(onSelect));

    const now = Date.now();
    const nowHour = new Date().setMinutes(0, 0, 0);
    const columns = [];

    series.forEach((entry, index) => {
      const time = new Date(entry.time);
      const startsAt = hourStart(entry.time);
      const hour = time.getHours();
      const score = entry.score;
      const missing = score === null || score === undefined;

      const column = document.createElement('div');
      column.className = missing ? 'hour is-empty' : 'hour';
      if (!missing) column.style.setProperty('--c', entry.color || scoreColor(score));
      column.dataset.time = entry.time;

      // An hour that has gone by stays on the chart as context, drawn grey. The
      // hour we are in is not past yet -- the now line sits partway through it.
      if (markNow && startsAt + HOUR_MS <= now) column.classList.add('is-past');
      if (markNow && startsAt === nowHour) column.classList.add('is-now');
      if (selected && entry.time === selected) column.classList.add('is-selected');

      const temperature =
        entry.temperature === null || entry.temperature === undefined
          ? ''
          : ` · ${Math.round(entry.temperature)} °C`;
      const clock = `${String(hour).padStart(2, '0')}:00`;
      column.title = missing
        ? `${clock} — ${emptyLabel}`
        : `${clock} — ${score.toFixed(1)} ${entry.label || scoreLabel(score)}${temperature}`;

      if (onSelect && !missing) {
        column.tabIndex = 0;
        column.setAttribute('role', 'button');
        column.setAttribute('aria-label', column.title);
        column.addEventListener('click', () => onSelect(entry, index));
        column.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onSelect(entry, index);
        });
      }

      // Label sparsely so the axis stays readable on a phone.
      column.dataset.label = hour % labelEvery === 0 ? String(hour).padStart(2, '0') : '';

      if (icons && entry.icon && index % iconEvery === 0) {
        const glyph = document.createElement('span');
        glyph.className = 'wx';
        glyph.textContent = entry.icon;
        column.append(glyph);
      }

      const bar = document.createElement('span');
      bar.className = 'fsi-bar';
      // An empty slot is drawn as the full height of the chart so it reads as
      // "we do not know", not as a score of nearly zero.
      bar.style.height = missing ? '100%' : `${Math.max(4, score * 10)}%`;

      if (temperatures && !missing) {
        const temperatureLabel = document.createElement('span');
        temperatureLabel.className = 'fsi-temperature';
        temperatureLabel.textContent =
          entry.temperature === null || entry.temperature === undefined
            ? '–'
            : `${Math.round(entry.temperature)}°`;
        temperatureLabel.style.color = contrastText(entry.color || scoreColor(score));
        bar.append(temperatureLabel);
      }

      if (options.values && !missing) {
        const value = document.createElement('b');
        value.className = 'fsi-value';
        value.textContent = score.toFixed(1);
        // Ink measured against the bar colour: the scale runs from green
        // through amber to pink, and amber needs dark text.
        value.style.color = contrastText(entry.color || scoreColor(score));
        // A very short bar has no room inside, so the number sits above it.
        if ((score / 10) * (host.clientHeight || 300) < 30) {
          value.classList.add('outside');
          value.style.color = '';
        }
        bar.append(value);
      }

      column.append(bar);
      host.append(column);
      columns.push(column);
    });

    if (markNow) drawNowLine(columns, series);

    // Warnings sit above the bars, best/worst below: two separate concerns.
    delete host.dataset.warnRows;
    host.style.removeProperty('--warn-rows');
    host.style.removeProperty('--range-rows');

    // Only reserve room for the warning track if one was actually drawn -- a
    // warning that covers no hour we are showing should cost no space.
    const warned =
      options.warnings?.length && drawRanges(host, series, options.warnings, 'warn-track');
    if (options.ranges?.length) drawRanges(host, series, options.ranges, 'ranges');
    host.classList.toggle('has-warnings', Boolean(warned));
  }

  /**
   * A red line at the current minute.
   *
   * Drawn inside the column the moment falls in, so it lands in the right place
   * without this having to know anything about the chart's own padding.
   */
  function drawNowLine(columns, series) {
    const now = Date.now();
    const index = series.findIndex((entry) => {
      const startsAt = hourStart(entry.time);
      return now >= startsAt && now < startsAt + HOUR_MS;
    });
    if (index === -1 || !columns[index]) return; // the chart does not cover now

    const line = document.createElement('span');
    line.className = 'now-line';
    line.style.left = `${((now - hourStart(series[index].time)) / HOUR_MS) * 100}%`;
    columns[index].append(line);
  }

  /**
   * Mark spans of hours on the chart -- the best/worst stretches and any active
   * warning belong on the bars they describe, not in a panel of their own.
   *
   * @param ranges   [{start, end, kind, labels, hatched, color}] with ISO start/end
   * @param maxRows  overlapping ranges each need a row, and every row makes the
   *                 panel taller; past this many the rest becomes a "+n" chip
   */
  function drawRanges(host, series, ranges, trackClass, maxRows = 3) {
    const track = document.createElement('div');
    track.className = trackClass;

    // Work out which bars each range covers first, so overlapping ranges can be
    // given their own row instead of being drawn on top of each other.
    const placed = [];
    for (const range of ranges) {
      if (!range) continue;
      const from = new Date(range.start).getTime();
      // An open-ended warning runs to the end of what we are showing.
      const to = range.end ? new Date(range.end).getTime() : Infinity;

      const covered = series
        .map((entry, index) => ({ index, at: new Date(entry.time).getTime() }))
        .filter((item) => item.at >= from && item.at < to)
        .map((item) => item.index);
      if (!covered.length) continue;

      placed.push({ range, first: Math.min(...covered), last: Math.max(...covered) });
    }
    if (!placed.length) return false; // in force, but not over any hour we show

    // Greedy row packing: first row that has space at those hours.
    const rows = [];
    const overflow = [];
    for (const item of placed) {
      let row = rows.findIndex(
        (occupied) => !occupied.some((o) => item.first <= o.last && item.last >= o.first)
      );
      if (row === -1) {
        // Every extra row pushes the whole panel taller. Past a few of them the
        // annotations dwarf the bars they annotate, so the rest is counted
        // rather than drawn -- the warning list still carries all of them.
        if (rows.length >= maxRows) {
          overflow.push(item);
          continue;
        }
        rows.push([]);
        row = rows.length - 1;
      }
      rows[row].push(item);
      item.row = row;
    }

    const rowElements = rows.map(() => {
      const element = document.createElement('div');
      element.className = 'row';
      track.append(element);
      return element;
    });

    // In the DOM before the labels go in: fitting them needs real measurements.
    host.append(track);

    for (const { range, first, last, row } of placed) {
      if (row === undefined) continue;
      const span = document.createElement('span');
      span.className = `range ${range.kind || ''}${range.hatched ? ' hatched' : ''}`;
      const left = (first / series.length) * 100;
      const width = ((last + 1 - first) / series.length) * 100;
      span.style.left = `${left}%`;
      span.style.width = `${width}%`;
      if (range.color) span.style.setProperty('--c', range.color);
      if (range.title) span.title = range.title;
      rowElements[row].append(span);
      fitLabel(span, rowElements[row], range, left, width);
    }

    if (overflow.length) {
      const chip = document.createElement('span');
      chip.className = 'range more';
      chip.textContent = `+${overflow.length}`;
      chip.title = overflow
        .map(({ range }) => range.title || (range.labels || [])[0] || '')
        .filter(Boolean)
        .join(' · ');
      rowElements[rowElements.length - 1].append(chip);
    }

    // The chart tells the stylesheet how many rows it drew, and the padding is
    // calculated from that -- three hard-coded steps used to leave a fourth row
    // of warnings lying across the bars.
    const drawn = String(rows.length);
    track.dataset.rows = drawn;
    host.style.setProperty(trackClass === 'warn-track' ? '--warn-rows' : '--range-rows', drawn);
    if (trackClass === 'warn-track') host.dataset.warnRows = drawn;
    return true;
  }

  /**
   * Fit a range's label to the band it sits in.
   *
   * A two-hour stretch is a sliver of a 24-hour chart and has no room for
   * "BEST 14:00 (2 PM) – 16:00 (4 PM)"; centred inside it, the text was clipped
   * at both ends and read as nothing at all. Try the variants longest first,
   * and if none of them fits, hang the label off whichever side has space.
   */
  function fitLabel(span, row, range, leftPct, widthPct) {
    const variants = range.labels?.length ? range.labels : [range.label || ''];
    const fits = () => span.scrollWidth <= span.clientWidth + 1;

    // Nothing to measure against (a chart drawn while its page is still
    // hidden): keep the full wording rather than banishing every label.
    if (!row.clientWidth) {
      span.textContent = variants[0];
      return;
    }

    for (const text of variants) {
      span.textContent = text;
      if (fits()) return;
    }

    span.textContent = ''; // even the shortest overflowed; the colour carries it
    span.classList.add('is-tight');

    const label = document.createElement('span');
    label.className = `range-label ${range.kind || ''}`;
    label.textContent = range.outsideLabel || variants[Math.min(1, variants.length - 1)];
    if (range.color) label.style.setProperty('--c', range.color);
    if (range.title) label.title = range.title;

    // Whichever side of the band has more room; the label is clamped to it so a
    // long one truncates instead of running off the end of the chart.
    const rightRoom = 100 - (leftPct + widthPct);
    if (rightRoom >= leftPct) {
      label.style.left = `calc(${leftPct + widthPct}% + 0.3em)`;
      label.style.maxWidth = `calc(${rightRoom}% - 0.6em)`;
    } else {
      label.style.right = `calc(${100 - leftPct}% + 0.3em)`;
      label.style.maxWidth = `calc(${leftPct}% - 0.6em)`;
    }
    row.append(label);
  }

  /**
   * Turn warnings into chart ranges. A Vorabinformation is drawn hatched in red:
   * it is DWD flagging possible severe weather, not a warning in force, and the
   * two must not look alike.
   */
  function warningRanges(warnings, options = {}) {
    const { withLabel = true } = options;
    return (warnings || [])
      .filter((warning) => warning.start)
      .map((warning) => {
        const name = warning.event_en || warning.event;
        return {
          start: warning.start,
          end: warning.end,
          kind: 'warn',
          hatched: Boolean(warning.advance),
          color: warning.advance ? '#e53935' : warning.color,
          // Longest first; a one-hour warning keeps just the glyph, or moves
          // its wording out beside the band.
          labels: withLabel ? [`⚠ ${name}`, '⚠'] : [''],
          outsideLabel: withLabel ? `⚠ ${name}` : '',
          title: [warning.event_en || warning.event, warning.headline].filter(Boolean).join(' — '),
        };
      });
  }

  return {
    scoreColor,
    scoreLabel,
    contrastText,
    luminance,
    hourStart,
    outlook,
    renderStrip,
    warningRanges,
    bands,
    setBands,
  };
})();
