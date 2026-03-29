export const config = { runtime: 'edge' };

// Verify session token matches what auth.js would have issued today (or yesterday for grace period)
async function verifyToken(token, password) {
  const encoder = new TextEncoder();
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    const d = new Date();
    d.setDate(d.getDate() - dayOffset);
    const dateStr = d.toISOString().split('T')[0];
    const tokenBase = `${password}:${dateStr}`;
    const data = encoder.encode(tokenBase);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const expected = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    if (token === expected) return true;
  }
  return false;
}

// Get Google OAuth2 access token using service account JWT
async function getAccessToken(clientEmail, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const encode = (obj) => btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const headerB64 = encode(header);
  const payloadB64 = encode(payload);
  const signingInput = `${headerB64}.${payloadB64}`;

  // Normalise key — handle \n as text or real newlines
  const normalised = privateKey.replace(/\\n/g, '\n').replace(/\r/g, '').trim();
  const pemContents = normalised.split('\n').filter(line => line && !line.startsWith('-----')).join('');
  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryDer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    encoder.encode(signingInput)
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const jwt = `${signingInput}.${sigB64}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error('No access token: ' + JSON.stringify(tokenData));
  }
  return tokenData.access_token;
}

// Clear a sheet tab and rewrite it with headers + rows
async function writeSheet(accessToken, spreadsheetId, sheetName, headers, rows) {
  const values = [headers, ...rows];
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}!A1:Z1000?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ range: `${sheetName}!A1:Z1000`, majorDimension: 'ROWS', values }),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Sheet "${sheetName}" failed: ${errText}`);
  }
  return true;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  const password = process.env.FOM_PASSWORD;
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  if (!password || !clientEmail || !privateKey || !spreadsheetId) {
    return new Response(JSON.stringify({ error: 'Server misconfigured' }), { status: 500 });
  }

  // Verify session token
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  const valid = await verifyToken(token, password);
  if (!valid) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  try {
    const { guests, episodes, ideas, questions } = await req.json();
    const accessToken = await getAccessToken(clientEmail, privateKey);

    // GUESTS
    await writeSheet(accessToken, spreadsheetId, 'Guests',
      ['Name', 'Category', 'Why Them', 'Email', 'Social', 'Connection Path', 'Status', 'Last Contact', 'Follow-up Date', 'Notes'],
      (guests || []).map(g => [g.name, g.category, g.why, g.email, g.social, g.connection, g.status, g.lastContact, g.followUpDate, g.notes])
    );

    // EPISODES
    await writeSheet(accessToken, spreadsheetId, 'Episodes',
      ['Episode #', 'Title', 'Guest', 'Format', 'Status', 'Record Date', 'Publish Date', 'YouTube URL', 'Notes', 'Checklist % Complete'],
      (episodes || []).map(ep => {
        const checklistKeys = [
          'Interview_questions_written','Research_brief_done','Guest_tech_check_complete_-_remote',
          'Location_confirmed','Studio_crew_briefed','Backup_recording_device_ready',
          'Primary_camera_ready','Audio_checked','Lighting_set','Set_and_background_dressed',
          'Intro_filmed','Raw_files_backed_up','Edit_complete','Colour_grade_done',
          'Audio_mix_done','Thumbnail_created','Title_and_description_written',
          'Captions_and_subtitles_done','End_screens_and_cards_added','Scheduled_on_YouTube'
        ];
        const checklist = ep.checklist || {};
        const done = checklistKeys.filter(k => checklist[k]).length;
        const pct = Math.round(done / checklistKeys.length * 100) + '%';
        return [ep.number, ep.title, ep.guest, ep.format, ep.status, ep.recordDate, ep.publishDate, ep.url, ep.notes, pct];
      })
    );

    // IDEAS
    await writeSheet(accessToken, spreadsheetId, 'Ideas',
      ['Title', 'Description', 'Why It Fits FOM', 'Source', 'Status'],
      (ideas || []).map(i => [i.title, i.desc, i.why, i.source, i.status])
    );

    // QUESTIONS
    await writeSheet(accessToken, spreadsheetId, 'Questions',
      ['Question', 'Category', 'Notes'],
      (questions || []).map(q => [q.text, q.category, q.notes])
    );

    return new Response(JSON.stringify({ success: true, synced: new Date().toISOString() }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
return new Response(JSON.stringify({ error: err.message, stack: err.stack }), { status: 500 });  }
}
