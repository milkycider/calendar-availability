// api/calendar.js
// Vercel Serverless Function - Google Calendar APIをサービスアカウントで呼び出す

export default async function handler(req, res) {
  try {
    const { year, month, from, to } = req.query;

    // サービスアカウントの認証情報（環境変数から取得）
    const serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const calendarIds = JSON.parse(process.env.CALENDAR_IDS); // ["id1@group.calendar.google.com", "id2@..."]
    const holidayCalendarId = 'ja.japanese#holiday@group.v.calendar.google.com';

    const accessToken = await getAccessToken(serviceAccountKey);

    let result;
    if (from || to) {
      // 複数月モード
      const fromStr = from || to;
      const toStr = to || from;
      const [fromYear, fromMonth] = fromStr.split('-').map(Number);
      const [toYear, toMonth] = toStr.split('-').map(Number);

      const months = [];
      let y = fromYear, m = fromMonth;
      while (y < toYear || (y === toYear && m <= toMonth)) {
        const data = await buildCalendarData(y, m, calendarIds, holidayCalendarId, accessToken);
        months.push({ year: y, month: m, data });
        m++;
        if (m > 12) { m = 1; y++; }
        if (months.length > 12) break;
      }
      result = { mode: 'multi', months };
    } else {
      // 単月モード
      const now = new Date();
      const y = parseInt(year) || now.getFullYear();
      const m = parseInt(month) || (now.getMonth() + 1);
      const data = await buildCalendarData(y, m, calendarIds, holidayCalendarId, accessToken);
      result = { mode: 'single', year: y, month: m, data };
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}

// ==============================
// サービスアカウントでアクセストークンを取得（JWT Bearer Flow）
// ==============================
async function getAccessToken(serviceAccountKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: serviceAccountKey.client_email,
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedClaim = base64url(JSON.stringify(claim));
  const signInput = `${encodedHeader}.${encodedClaim}`;

  const signature = await signWithPrivateKey(signInput, serviceAccountKey.private_key);
  const jwt = `${signInput}.${signature}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error('トークン取得失敗: ' + JSON.stringify(tokenData));
  }
  return tokenData.access_token;
}

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function signWithPrivateKey(input, privateKeyPem) {
  const crypto = await import('crypto');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(input);
  signer.end();
  const signature = signer.sign(privateKeyPem);
  return signature.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// JST(UTC+9)を明示して日時を作るヘルパー
function jstDate(year, month, day, hour) {
  hour = hour || 0;
  // JSTのその時刻を、UTC基準のミリ秒に変換
  // year-month-day hour:00 JST = (hour - 9):00 UTC の同日 (負なら前日)
  return new Date(Date.UTC(year, month - 1, day, hour - 9, 0, 0));
}

// ==============================
// カレンダーデータ構築
// ==============================
async function buildCalendarData(year, month, calendarIds, holidayCalendarId, accessToken) {
  const startDate = jstDate(year, month, 1, 0);
  const endDate = jstDate(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1, 0);

  const events = await getAllEvents(calendarIds, startDate, endDate, accessToken);
  const holidays = await getHolidays(holidayCalendarId, startDate, endDate, accessToken);

  const now = new Date();
  // 「今日」もJST基準で判定する
  const jstNowMs = now.getTime() + 9 * 60 * 60 * 1000;
  const jstNow = new Date(jstNowMs);
  const todayY = jstNow.getUTCFullYear();
  const todayM = jstNow.getUTCMonth() + 1;
  const todayD = jstNow.getUTCDate();
  const tomorrow = jstDate(todayY, todayM, todayD + 1, 0);

  const daysInMonth = new Date(year, month, 0).getDate();

  const result = {};

  for (let d = 1; d <= daysInMonth; d++) {
    const dateUtcNoon = jstDate(year, month, d, 12); // dow判定用（正午JSTなら日付ズレしない）
    const dow = dateUtcNoon.getUTCDay();
    const isHoliday = !!holidays[formatDateYMD(year, month, d)];
    const isOff = (dow === 0 || dow === 6) || isHoliday;
    const dateStart = jstDate(year, month, d, 0);
    const isPast = dateStart < tomorrow;

    let slots = null;
    if (!isPast) {
      const dayEvents = getDayEvents(events, year, month, d);
      slots = {
        weekdayNight: isOff ? null : isSlotFree(year, month, d, 21, 24, dayEvents),
        holidayDay: !isOff ? null : isSlotFree(year, month, d, 0, 19, dayEvents),
        holidayNight: !isOff ? null : isSlotFree(year, month, d, 21, 24, dayEvents)
      };
    }

    result[d] = { dow, isOff, isHoliday, isPast, slots };
  }

  return result;
}

async function getAllEvents(calendarIds, startDate, endDate, accessToken) {
  let allEvents = [];
  for (const calId of calendarIds) {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?timeMin=${startDate.toISOString()}&timeMax=${endDate.toISOString()}&singleEvents=true`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json();
    if (data.items) {
      allEvents = allEvents.concat(data.items.map(ev => ({
        start: ev.start.dateTime || ev.start.date,
        end: ev.end.dateTime || ev.end.date,
        isAllDay: !ev.start.dateTime
      })));
    }
  }
  return allEvents;
}

async function getHolidays(holidayCalendarId, startDate, endDate, accessToken) {
  const holidays = {};
  try {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(holidayCalendarId)}/events?timeMin=${startDate.toISOString()}&timeMax=${endDate.toISOString()}&singleEvents=true`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json();
    if (data.items) {
      data.items.forEach(ev => {
        // 祝日カレンダーは終日イベント(date形式 YYYY-MM-DD)なのでそのまま使える
        const d = ev.start.date || ev.start.dateTime;
        holidays[d.substring(0, 10)] = true;
      });
    }
  } catch (e) {}
  return holidays;
}

function getDayEvents(events, year, month, day) {
  const dayStart = jstDate(year, month, day, 0);
  const dayEnd = jstDate(year, month, day + 1, 0);
  return events.filter(ev => {
    if (ev.isAllDay) {
      // 終日イベントは日付文字列で比較（date形式: YYYY-MM-DD, endは翌日扱いの場合あり）
      const evStartDate = ev.start.substring(0, 10);
      const evEndDate = ev.end.substring(0, 10);
      const targetDate = formatDateYMD(year, month, day);
      return evStartDate <= targetDate && targetDate < evEndDate;
    }
    const evStart = new Date(ev.start);
    const evEnd = new Date(ev.end);
    return evStart < dayEnd && evEnd > dayStart;
  });
}

function isSlotFree(year, month, day, startHour, endHour, events) {
  const slotStart = jstDate(year, month, day, startHour);
  const slotEnd = jstDate(year, month, day, endHour);
  for (const ev of events) {
    if (ev.isAllDay) return false; // 終日予定がある日は全スロット不可
    const evStart = new Date(ev.start);
    const evEnd = new Date(ev.end);
    if (evStart < slotEnd && evEnd > slotStart) return false;
  }
  return true;
}

function formatDateYMD(year, month, day) {
  return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}
