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

// ==============================
// カレンダーデータ構築
// ==============================
async function buildCalendarData(year, month, calendarIds, holidayCalendarId, accessToken) {
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 1);

  const events = await getAllEvents(calendarIds, startDate, endDate, accessToken);
  const holidays = await getHolidays(holidayCalendarId, startDate, endDate, accessToken);

  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const daysInMonth = new Date(year, month, 0).getDate();

  const result = {};

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month - 1, d);
    const dow = date.getDay();
    const isHoliday = !!holidays[formatDate(date)];
    const isOff = (dow === 0 || dow === 6) || isHoliday;
    const isPast = date < tomorrow;

    let slots = null;
    if (!isPast) {
      const dayEvents = getDayEvents(events, date);
      slots = {
        weekdayNight: isOff ? null : isSlotFree(date, 21, 24, dayEvents),
        holidayDay: !isOff ? null : isSlotFree(date, 0, 19, dayEvents),
        holidayNight: !isOff ? null : isSlotFree(date, 21, 24, dayEvents)
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
        const d = ev.start.date || ev.start.dateTime;
        holidays[d.substring(0, 10)] = true;
      });
    }
  } catch (e) {}
  return holidays;
}

function getDayEvents(events, date) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return events.filter(ev => {
    if (ev.isAllDay) return false;
    const evStart = new Date(ev.start);
    const evEnd = new Date(ev.end);
    return evStart < next && evEnd > date;
  });
}

function isSlotFree(date, startHour, endHour, events) {
  const slotStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), startHour);
  const slotEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate(), endHour);
  for (const ev of events) {
    const evStart = new Date(ev.start);
    const evEnd = new Date(ev.end);
    if (evStart < slotEnd && evEnd > slotStart) return false;
  }
  return true;
}

function formatDate(date) {
  return date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
}
