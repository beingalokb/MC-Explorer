// =========================
// MC-Explorer: Search Assets Module
// =========================
// This section implements robust, stateless endpoints for searching and displaying
// Salesforce Marketing Cloud assets (Data Extensions, Automations, Data Filters, Journeys)
// with full folder paths, metadata, and user-friendly frontend integration.
//
// Future enhancements: prompt-based asset building, Preference Center, etc.
// =========================

// server.js (Full with working auth redirect)
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');
const session = require('express-session');
const upsertRow = require('./upsertRow');
const retrieveSendByJobId = require('./retrieveSend');
const { retrieveSendWithFilter } = require('./retrieveSend');

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));
app.use(session({
  secret: 'your-very-secret-key', // use a strong secret in production!
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // set to true if using HTTPS
}));

const PORT = process.env.PORT || 3001;

// Middleware to check for MC credentials in session
function requireMCCreds(req, res, next) {
  if (req.session.mcCreds && req.session.mcCreds.subdomain && req.session.mcCreds.clientId && req.session.mcCreds.clientSecret) {
    return next();
  }
  res.redirect('/setup');
}

// Save credentials to session (per user)
app.post('/save-credentials', (req, res) => {
  const { subdomain, clientId, clientSecret, accountId } = req.body;
  req.session.mcCreds = { subdomain, clientId, clientSecret, accountId };
  console.log('🔔 /save-credentials (session) received:', req.session.mcCreds);
  res.json({ success: true });
});

// Initiate Marketing Cloud OAuth login
app.get('/auth/login', (req, res) => {
  const creds = req.session.mcCreds;
  if (!creds || !creds.subdomain || !creds.clientId) {
    return res.redirect('/setup');
  }
  const redirectUri = 'https://mc-explorer.onrender.com/auth/callback';
  const loginUrl = `https://${creds.subdomain}.auth.marketingcloudapis.com/v2/authorize?client_id=${creds.clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`;
  res.redirect(loginUrl);
});

// Handle OAuth callback: exchange code for access token
app.post('/auth/callback', async (req, res) => {
  const code = req.body.code;
  const creds = req.session.mcCreds;
  if (!creds || !creds.subdomain || !creds.clientId || !creds.clientSecret) {
    return res.status(400).json({ success: false, error: 'Missing credentials' });
  }
  try {
    const tokenResponse = await axios.post(
      `https://${creds.subdomain}.auth.marketingcloudapis.com/v2/token`,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: 'https://mc-explorer.onrender.com/auth/callback'
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const accessToken = tokenResponse.data.access_token;
    const refreshToken = tokenResponse.data.refresh_token;
    req.session.accessToken = accessToken;
    res.json({ success: true, accessToken, refreshToken, subdomain: creds.subdomain });
  } catch (err) {
    console.error('❌ OAuth callback error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

// Helper to get access token from request
function getAccessTokenFromRequest(req) {
  // Try to get access token from Authorization header (Bearer ...)
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  // Or from session (if you stored it there)
  if (req.session && req.session.accessToken) {
    return req.session.accessToken;
  }
  return null;
}

// Helper to get subdomain from request
function getSubdomainFromRequest(req) {
  // Try to get subdomain from custom header (used by frontend)
  if (req.headers['x-mc-subdomain']) {
    return req.headers['x-mc-subdomain'];
  }
  // Or from session credentials
  if (req.session && req.session.mcCreds && req.session.mcCreds.subdomain) {
    return req.session.mcCreds.subdomain;
  }
  return null;
}

// Helper to get MC access token from session credentials
async function getMCAccessToken(req) {
  const creds = req.session.mcCreds;
  if (!creds) throw new Error('No Marketing Cloud credentials in session');
  const url = `https://${creds.subdomain}.auth.marketingcloudapis.com/v2/token`;
  const resp = await axios.post(url, {
    grant_type: 'client_credentials',
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    account_id: creds.accountId
  });
  return resp.data.access_token;
}

// Endpoint to check if backend has credentials (per session)
app.get('/has-credentials', (req, res) => {
  const creds = req.session.mcCreds || {};
  console.log('🟢 /has-credentials (session) check:', creds);
  const hasCreds = !!(creds.subdomain && creds.clientId && creds.clientSecret);
  res.json({ hasCreds });
});

// Logout route to clear session
app.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ success: false });
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// Example: protect dashboard route
// app.get('/dashboard', requireMCCreds, (req, res) => {
//   // ...serve dashboard or API logic
// });

// Use req.session.mcCreds for all MC API calls
function getMCCreds(req) {
  return req.session.mcCreds;
}

// =========================
// MC-Explorer: Search Assets Module (continued)
// =========================

// Helper to build folder path from folderMap
function buildFolderPath(folderId, folderMap) {
  let path = [];
  let current = folderMap[folderId];
  while (current) {
    path.unshift(current.Name);
    current = current.ParentFolder && folderMap[current.ParentFolder.ID];
  }
  return '/' + path.join(' / ');
}

// Data Extension Search (SOAP + REST for createdByName)
app.get('/search/de', async (req, res) => {
  const accessToken = getAccessTokenFromRequest(req);
  const subdomain = getSubdomainFromRequest(req);
  if (!accessToken || !subdomain) {
    return res.status(401).json([]);
  }
  try {
    // Fetch all folders first (SOAP, as before)
    const folderEnvelope = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <s:Header><fueloauth>${accessToken}</fueloauth></s:Header>
        <s:Body>
          <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <RetrieveRequest>
              <ObjectType>DataFolder</ObjectType>
              <Properties>ID</Properties>
              <Properties>Name</Properties>
              <Properties>ParentFolder.ID</Properties>
              <Properties>ContentType</Properties>
              <Filter xsi:type="SimpleFilterPart">
                <Property>IsActive</Property>
                <SimpleOperator>equals</SimpleOperator>
                <Value>true</Value>
              </Filter>
            </RetrieveRequest>
          </RetrieveRequestMsg>
        </s:Body>
      </s:Envelope>`;
    const folderResp = await axios.post(
      `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
      folderEnvelope,
      { headers: { 'Content-Type': 'text/xml', SOAPAction: 'Retrieve' } }
    );
    const folderParser = new xml2js.Parser({ explicitArray: false });
    let folderMap = {};
    await folderParser.parseStringPromise(folderResp.data).then(result => {
      const results = result?.['soap:Envelope']?.['soap:Body']?.['RetrieveResponseMsg']?.['Results'];
      const folders = Array.isArray(results) ? results : [results];
      folders.forEach(f => {
        if (f && f.ID) folderMap[String(f.ID)] = f;
      });
    });
    // Fetch DEs via SOAP
    const soapEnvelope = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
        <s:Header>
          <fueloauth>${accessToken}</fueloauth>
        </s:Header>
        <s:Body>
          <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <RetrieveRequest>
              <ObjectType>DataExtension</ObjectType>
              <Properties>Name</Properties>
              <Properties>CustomerKey</Properties>
              <Properties>CreatedDate</Properties>
              <Properties>CategoryID</Properties>
              <Properties>ObjectID</Properties>
            </RetrieveRequest>
          </RetrieveRequestMsg>
        </s:Body>
      </s:Envelope>
    `;
    const response = await axios.post(
      `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
      soapEnvelope,
      {
        headers: {
          'Content-Type': 'text/xml',
          SOAPAction: 'Retrieve',
        },
      }
    );
    const parser = new xml2js.Parser({ explicitArray: false });
    parser.parseString(response.data, (err, result) => {
      if (err) {
        console.error('❌ XML Parse Error:', err);
        return res.status(500).json({ error: 'Failed to parse XML' });
      }
      try {
        const results = result?.['soap:Envelope']?.['soap:Body']?.['RetrieveResponseMsg']?.['Results'];
        if (!results) return res.status(200).json([]);
        const resultArray = Array.isArray(results) ? results : [results];
        // Only return basic DE info, no REST call for createdByName
        const deList = resultArray.map(de => ({
          name: de.Name || 'N/A',
          key: de.CustomerKey || 'N/A',
          createdDate: de.CreatedDate || 'N/A',
          categoryId: de.CategoryID || '',
          objectId: de.ObjectID || '',
          id: de.ID || de.ObjectID || '', // fallback to ObjectID if ID is missing
          path: buildFolderPath(de.CategoryID, folderMap)
        }));
        res.json(deList);
      } catch (e) {
        console.error('❌ DE structure error:', e);
        res.status(500).json({ error: 'Unexpected DE format' });
      }
    });
  } catch (err) {
    console.error('❌ DE fetch failed:', err.response?.data || err);
    res.status(500).json({ error: 'Failed to fetch DEs' });
  }
});

// Automation Search (REST, revert to previous working version)
app.get('/search/automation', async (req, res) => {
  const accessToken = getAccessTokenFromRequest(req);
  const subdomain = getSubdomainFromRequest(req);
  if (!accessToken || !subdomain) {
    return res.status(401).json([]);
  }
  try {
    // Fetch all folders first (SOAP, as before)
    const folderEnvelope = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <s:Header><fueloauth>${accessToken}</fueloauth></s:Header>
        <s:Body>
          <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <RetrieveRequest>
              <ObjectType>DataFolder</ObjectType>
              <Properties>ID</Properties>
              <Properties>Name</Properties>
              <Properties>ParentFolder.ID</Properties>
              <Properties>ContentType</Properties>
              <Filter xsi:type="SimpleFilterPart">
                <Property>IsActive</Property>
                <SimpleOperator>equals</SimpleOperator>
                <Value>true</Value>
              </Filter>
            </RetrieveRequest>
          </RetrieveRequestMsg>
        </s:Body>
      </s:Envelope>`;
    const folderResp = await axios.post(
      `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
      folderEnvelope,
      { headers: { 'Content-Type': 'text/xml', SOAPAction: 'Retrieve' } }
    );
    const folderParser = new xml2js.Parser({ explicitArray: false });
    let folderMap = {};
    await folderParser.parseStringPromise(folderResp.data).then(result => {
      const results = result?.['soap:Envelope']?.['soap:Body']?.['RetrieveResponseMsg']?.['Results'];
      const folders = Array.isArray(results) ? results : [results];
      folders.forEach(f => {
        if (f && f.ID) folderMap[String(f.ID)] = f;
      });
    });
    // Fetch Automations via REST
    const response = await axios.get(
      `https://${subdomain}.rest.marketingcloudapis.com/automation/v1/automations`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );
    const automations = response.data.items || [];
    if (automations.length > 0) console.log('🔎 Raw Automation:', JSON.stringify(automations[0], null, 2));
    const simplified = automations.map(a => ({
      id: a.id,
      name: a.name || 'N/A',
      key: a.key || a.customerKey || 'N/A',
      status: a.status || a.statusId || 'N/A',
      path: buildFolderPath(a.categoryId, folderMap)
    }));
    res.json(simplified);
  } catch (err) {
    console.error('❌ Automation REST error:', err.response?.data || err);
    res.status(500).json({ error: 'Failed to fetch Automations via REST' });
  }
});

// On-demand Automation details endpoint
app.get('/automation/details', async (req, res) => {
  const accessToken = getAccessTokenFromRequest(req);
  const subdomain = getSubdomainFromRequest(req);
  const programId = req.query.programId;
  if (!accessToken || !subdomain || !programId) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }
  try {
    const restResp = await axios.get(
      `https://${subdomain}.rest.marketingcloudapis.com/automation/v1/automations/${programId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const item = restResp.data;
    res.json({
      startDate: item.startDate || 'N/A',
      endDate: item.endDate || 'N/A',
      lastRunTime: item.lastRunTime || 'N/A',
      // Add more fields if needed
    });
  } catch (e) {
    console.error('Failed to fetch Automation details:', e?.response?.data || e);
    res.status(500).json({ error: 'Failed to fetch Automation details', details: e?.message || e });
  }
});

// Data Filter Search
app.get('/search/datafilters', async (req, res) => {
  const accessToken = getAccessTokenFromRequest(req);
  const subdomain = getSubdomainFromRequest(req);
  if (!accessToken || !subdomain) {
    return res.status(401).json([]);
  }
  try {
    // Fetch all folders first
    const folderEnvelope = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <s:Header><fueloauth>${accessToken}</fueloauth></s:Header>
        <s:Body>
          <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <RetrieveRequest>
              <ObjectType>DataFolder</ObjectType>
              <Properties>ID</Properties>
              <Properties>Name</Properties>
              <Properties>ParentFolder.ID</Properties>
              <Properties>ContentType</Properties>
              <Filter xsi:type="SimpleFilterPart">
                <Property>IsActive</Property>
                <SimpleOperator>equals</SimpleOperator>
                <Value>true</Value>
              </Filter>
            </RetrieveRequest>
          </RetrieveRequestMsg>
        </s:Body>
      </s:Envelope>`;
    const folderResp = await axios.post(
      `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
      folderEnvelope,
      { headers: { 'Content-Type': 'text/xml', SOAPAction: 'Retrieve' } }
    );
    const folderParser = new xml2js.Parser({ explicitArray: false });
    let folderMap = {};
    await folderParser.parseStringPromise(folderResp.data).then(result => {
      const results = result?.['soap:Envelope']?.['soap:Body']?.['RetrieveResponseMsg']?.['Results'];
      const folders = Array.isArray(results) ? results : [results];
      folders.forEach(f => {
        if (f && f.ID) folderMap[String(f.ID)] = f;
      });
    });
    // Fetch Data Filters
    const envelope = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" 
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <s:Header>
          <fueloauth>${accessToken}</fueloauth>
        </s:Header>
        <s:Body>
          <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <RetrieveRequest>
              <ObjectType>FilterDefinition</ObjectType>
              <Properties>Name</Properties>
              <Properties>CustomerKey</Properties>
              <Properties>Description</Properties>
              <Properties>CreatedDate</Properties>
              <Properties>CategoryID</Properties>
              <Filter xsi:type="SimpleFilterPart">
                <Property>Name</Property>
                <SimpleOperator>isNotNull</SimpleOperator>
              </Filter>
            </RetrieveRequest>
          </RetrieveRequestMsg>
        </s:Body>
      </s:Envelope>
    `;
    const response = await axios.post(
      `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
      envelope,
      {
        headers: {
          'Content-Type': 'text/xml',
          'SOAPAction': 'Retrieve',
        }
      }
    );
    const parser = new xml2js.Parser({ explicitArray: false });
    parser.parseString(response.data, (err, result) => {
      if (err) {
        console.error('❌ Failed to parse data filter SOAP response:', err);
        return res.status(500).json({ error: 'XML parse error' });
      }
      const filterResults =
        result['soap:Envelope']?.['soap:Body']?.RetrieveResponseMsg?.Results;
      if (!filterResults) {
        return res.json([]);
      }
      const normalized = Array.isArray(filterResults)
        ? filterResults
        : [filterResults];
      // Log raw Data Filter result for createdByName troubleshooting
      if (normalized.length > 0) console.log('🔎 Raw DataFilter:', JSON.stringify(normalized[0], null, 2));
      const dataFilters = normalized.map(item => ({
        name: item.Name || 'N/A',
        key: item.CustomerKey || 'N/A',
        customerKey: item.CustomerKey || '',
        id: item.CategoryID || '', // Use CategoryID for Data Filter View link
        description: item.Description || 'N/A',
        createdDate: item.CreatedDate || 'N/A',
        createdByName: item.CreatedBy || item.CreatedByName || 'N/A',
        path: buildFolderPath(item.CategoryID, folderMap)
      }));
      res.json(dataFilters);
    });
  } catch (err) {
    console.error('❌ Data Filter error:', err);
    res.status(500).json({ error: 'Failed to fetch data filters' });
  }
});

// Journey Search
app.get('/search/journeys', async (req, res) => {
  const accessToken = getAccessTokenFromRequest(req);
  const subdomain = getSubdomainFromRequest(req);
  if (!accessToken || !subdomain) {
    return res.status(401).json([]);
  }
  try {
    // Fetch all folders first
    const folderEnvelope = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <s:Header><fueloauth>${accessToken}</fueloauth></s:Header>
        <s:Body>
          <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <RetrieveRequest>
              <ObjectType>DataFolder</ObjectType>
              <Properties>ID</Properties>
              <Properties>Name</Properties>
              <Properties>ParentFolder.ID</Properties>
              <Properties>ContentType</Properties>
              <Filter xsi:type="SimpleFilterPart">
                <Property>IsActive</Property>
                <SimpleOperator>equals</SimpleOperator>
                <Value>true</Value>
              </Filter>
            </RetrieveRequest>
          </RetrieveRequestMsg>
        </s:Body>
      </s:Envelope>`;
    const folderResp = await axios.post(
      `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
      folderEnvelope,
      { headers: { 'Content-Type': 'text/xml', SOAPAction: 'Retrieve' } }
    );
    const folderParser = new xml2js.Parser({ explicitArray: false });
    let folderMap = {};
    await folderParser.parseStringPromise(folderResp.data).then(result => {
      const results = result?.['soap:Envelope']?.['soap:Body']?.['RetrieveResponseMsg']?.['Results'];
      const folders = Array.isArray(results) ? results : [results];
      folders.forEach(f => {
        if (f && f.ID) folderMap[String(f.ID)] = f;
      });
    });
    // Fetch Journeys
    const response = await axios.get(
      `https://${subdomain}.rest.marketingcloudapis.com/interaction/v1/interactions`,
      {
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );
    const journeys = response.data.items || [];
    // Log raw Journey result for createdByName troubleshooting
    if (journeys.length > 0) console.log('🔎 Raw Journey:', JSON.stringify(journeys[0], null, 2));
    const simplified = journeys.map(j => ({
      name: j.name || 'N/A',
      key: j.key || 'N/A',
      status: j.status || 'N/A',
      lastPublishedDate: j.lastPublishedDate || 'N/A',
      versionNumber: j.versionNumber || 'N/A',
      createdDate: j.createdDate || 'Not Available',
      createdByName: j.createdByName || j.createdBy || 'N/A',
      path: buildFolderPath(j.categoryId, folderMap)
    }));
    res.json(simplified);
  } catch (err) {
    console.error('❌ Journey fetch error:', err.response?.data || err);
    res.status(500).json({ error: 'Failed to fetch journeys' });
  }
});

// On-demand Data Extension details endpoint
app.get('/de/details', async (req, res) => {
  const accessToken = getAccessTokenFromRequest(req);
  const subdomain = getSubdomainFromRequest(req);
  const name = req.query.name;
  if (!accessToken || !subdomain || !name) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }
  try {
    // REST call for DE details
    const restResp = await axios.get(
      `https://${subdomain}.rest.marketingcloudapis.com/data/v1/customobjects?$search=${encodeURIComponent(name)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const item = restResp.data.items && restResp.data.items.find(obj => obj.name === name);
    if (!item) {
      console.warn(`DE not found in REST for name: ${name}`);
      return res.status(404).json({ error: 'Data Extension not found' });
    }
    // SOAP call for rowCount, isSendable, isTestable
    const soapEnvelope = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
        <s:Body>
          <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <RetrieveRequest>
              <ObjectType>DataExtension</ObjectType>
              <Properties>Name</Properties>
              <Properties>CustomerKey</Properties>
              <Properties>IsSendable</Properties>
              <Properties>IsTestable</Properties>
              <Properties>RowCount</Properties>
              <Filter xsi:type="SimpleFilterPart" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
                <Property>Name</Property>
                <SimpleOperator>equals</SimpleOperator>
                <Value>${name}</Value>
              </Filter>
            </RetrieveRequest>
          </RetrieveRequestMsg>
        </s:Body>
      </s:Envelope>
    `;
    let deDetails = null;
    try {
      const soapResp = await axios.post(
        `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
        soapEnvelope,
        {
          headers: {
            'Content-Type': 'text/xml',
            SOAPAction: 'Retrieve',
          },
        }
      );
      const parser = new xml2js.Parser({ explicitArray: false });
      await new Promise((resolve, reject) => {
        parser.parseString(soapResp.data, (err, result) => {
          if (err) return reject(err);
          const details = result?.['soap:Envelope']?.['soap:Body']?.['RetrieveResponseMsg']?.['Results'];
          deDetails = Array.isArray(details) ? details[0] : details;
          resolve();
        });
      });
    } catch (soapErr) {
      console.error('SOAP error for DE details:', soapErr);
      // Continue, but deDetails may be null
    }
    res.json({
      createdByName: item.createdByName || 'N/A',
      modifiedByName: item.modifiedByName || 'N/A',
      rowCount: item.rowCount !== undefined ? item.rowCount : (deDetails?.RowCount || 'N/A'),
      isSendable: item.isSendable !== undefined ? item.isSendable : (deDetails?.IsSendable || 'N/A'),
      isTestable: item.isTestable !== undefined ? item.isTestable : (deDetails?.IsTestable || 'N/A'),
    });
  } catch (e) {
    console.error('Failed to fetch DE details:', e?.response?.data || e);
    res.status(500).json({ error: 'Failed to fetch DE details', details: e?.message || e });
  }
});

// =========================
// Preference Center API (Step 1)
// =========================
const PREFERENCE_PROJECTS_DE = 'Preference_Center_Projects';

app.post('/api/preference-center/project', async (req, res) => {
  const accessToken = getAccessTokenFromRequest(req);
  const subdomain = getSubdomainFromRequest(req);
  const { name, routeType, targetBU } = req.body;
  if (!accessToken || !subdomain || !name || !routeType || !targetBU) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    // Create the DE if it doesn't exist (idempotent)
    const soapEnvelope = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
        <s:Header>
          <fueloauth>${accessToken}</fueloauth>
        </s:Header>
        <s:Body>
          <CreateRequest xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <Options/>
            <Objects xsi:type="DataExtension" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
              <CustomerKey>${PREFERENCE_PROJECTS_DE}</CustomerKey>
              <Name>${PREFERENCE_PROJECTS_DE}</Name>
              <Description>Preference Center Projects created by MC Explorer</Description>
              <Fields>
                <Field><Name>ProjectName</Name><FieldType>Text</FieldType><MaxLength>100</MaxLength></Field>
                <Field><Name>RouteType</Name><FieldType>Text</FieldType><MaxLength>30</MaxLength></Field>
                <Field><Name>TargetBU</Name><FieldType>Text</FieldType><MaxLength>100</MaxLength></Field>
                <Field><Name>CreatedDate</Name><FieldType>Date</FieldType></Field>
              </Fields>
            </Objects>
          </CreateRequest>
        </s:Body>
      </s:Envelope>
    `;
    await axios.post(
      `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
      soapEnvelope,
      { headers: { 'Content-Type': 'text/xml', SOAPAction: 'Create' } }
    );
    // Insert the project record
    const now = new Date().toISOString();
    const insertEnvelope = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
        <s:Header>
          <fueloauth>${accessToken}</fueloauth>
        </s:Header>
        <s:Body>
          <CreateRequest xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <Options/>
            <Objects xsi:type="DataExtensionObject" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
              <CustomerKey>${PREFERENCE_PROJECTS_DE}</CustomerKey>
              <Properties>
                <Property><Name>ProjectName</Name><Value>${name}</Value></Property>
                <Property><Name>RouteType</Name><Value>${routeType}</Value></Property>
                <Property><Name>TargetBU</Name><Value>${targetBU}</Value></Property>
                <Property><Name>CreatedDate</Name><Value>${now}</Value></Property>
              </Properties>
            </Objects>
          </CreateRequest>
        </s:Body>
      </s:Envelope>
    `;
    await axios.post(
      `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
      insertEnvelope,
      { headers: { 'Content-Type': 'text/xml', SOAPAction: 'Create' } }
    );
    res.json({ success: true });
  } catch (e) {
    console.error('Preference Center Project creation error:', e?.response?.data || e);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// === Preference Center Builder: Advanced Endpoints ===

// 1. Folder Path Validation
app.post('/folders', async (req, res) => {
  const { folderPath } = req.body;
  const accessToken = getAccessTokenFromRequest(req);
  const subdomain = getSubdomainFromRequest(req);
  if (!folderPath || !accessToken || !subdomain) {
    return res.status(400).json({ valid: false, error: 'Missing folderPath, accessToken, or subdomain' });
  }
  try {
    // Fetch all folders (SOAP)
    const folderEnvelope = `
      <s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">
        <s:Header><fueloauth>${accessToken}</fueloauth></s:Header>
        <s:Body>
          <RetrieveRequestMsg xmlns=\"http://exacttarget.com/wsdl/partnerAPI\">
            <RetrieveRequest>
              <ObjectType>DataFolder</ObjectType>
              <Properties>ID</Properties>
              <Properties>Name</Properties>
              <Properties>ParentFolder.ID</Properties>
              <Properties>ContentType</Properties>
              <Filter xsi:type=\"SimpleFilterPart\">
                <Property>IsActive</Property>
                <SimpleOperator>equals</SimpleOperator>
                <Value>true</Value>
              </Filter>
            </RetrieveRequest>
          </RetrieveRequestMsg>
        </s:Body>
      </s:Envelope>`;
    const folderResp = await axios.post(
      `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
      folderEnvelope,
      { headers: { 'Content-Type': 'text/xml', SOAPAction: 'Retrieve' } }
    );
    const folderParser = new xml2js.Parser({ explicitArray: false });
    let folderMap = {};
    await folderParser.parseStringPromise(folderResp.data).then(result => {
      const results = result?.['soap:Envelope']?.['soap:Body']?.['RetrieveResponseMsg']?.['Results'];
      const folders = Array.isArray(results) ? results : [results];
      folders.forEach(f => {
        if (f && f.ID) folderMap[String(f.ID)] = f;
      });
    });
    // Validate path
    const pathParts = folderPath.split('/').map(s => s.trim()).filter(Boolean);
    let currentParent = null;
    let found = false;
    for (const part of pathParts) {
      found = false;
      for (const id in folderMap) {
        const f = folderMap[id];
        if (f.Name === part && (currentParent === null || (f.ParentFolder && String(f.ParentFolder.ID) === String(currentParent)))) {
          currentParent = id;
          found = true;
          break;
        }
      }
      if (!found) break;
    }
    if (found) {
      return res.json({ valid: true, folderId: currentParent });
    } else {
      return res.json({ valid: false, error: 'Folder path not found' });
    }
  } catch (err) {
    console.error('/folders error:', err);
    res.status(500).json({ valid: false, error: 'Server error' });
  }
});

// 2. DE Lookup/Autocomplete
app.get('/de-lookup', async (req, res) => {
  const { query } = req.query;
  const accessToken = getAccessTokenFromRequest(req);
  const subdomain = getSubdomainFromRequest(req);
  if (!accessToken || !subdomain) {
    return res.status(401).json([]);
  }
  try {
    // Fetch DEs via SOAP
    const soapEnvelope = `
      <s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\">
        <s:Header>
          <fueloauth>${accessToken}</fueloauth>
        </s:Header>
        <s:Body>
          <RetrieveRequestMsg xmlns=\"http://exacttarget.com/wsdl/partnerAPI\">
            <RetrieveRequest>
              <ObjectType>DataExtension</ObjectType>
              <Properties>Name</Properties>
              <Properties>CustomerKey</Properties>
              <Properties>CategoryID</Properties>
            </RetrieveRequest>
          </RetrieveRequestMsg>
        </s:Body>
      </s:Envelope>
    `;
    const response = await axios.post(
      `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
      soapEnvelope,
      {
        headers: {
          'Content-Type': 'text/xml',
          SOAPAction: 'Retrieve',
        },
      }
    );
    const parser = new xml2js.Parser({ explicitArray: false });
    parser.parseString(response.data, (err, result) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to parse XML' });
      }
      const results = result?.['soap:Envelope']?.['soap:Body']?.['RetrieveResponseMsg']?.['Results'];
      if (!results) return res.json([]);
      const resultArray = Array.isArray(results) ? results : [results];
      let deList = resultArray.map(de => ({
        name: de.Name || 'N/A',
        key: de.CustomerKey || 'N/A',
        categoryId: de.CategoryID || ''
      }));
      if (query) {
        deList = deList.filter(de => de.name.toLowerCase().includes(query.toLowerCase()));
      }
      res.json(deList);
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch DEs' });
  }
});

// 3. Save Full Preference Center Config
function generateCloudPageContent(config) {
  // AMPscript variable setup
  const identifierField = config.subscriberIdentifier?.customParamName || config.subscriberIdentifier?.type || 'SubscriberKey';
  const emailField = 'email';
  const preferences = config.preferences || [];
  const optOutField = config.masterOptOut?.enabled ? config.masterOptOut.fieldApiName : null;
  const logDE = config.changeLogging?.enabled ? config.changeLogging.logDE?.name : null;
  const deName = config.dataExtension?.deName || config.newDeName || config.existingDeName;
  const redirectUrl = config.confirmationBehavior?.type === 'redirect' ? config.confirmationBehavior.redirectUrl : null;
  // AMPscript: SET vars
  let ampscript = [
    '%%[',
    'VAR @submit, @cid, @email' + preferences.map((p, i) => `, @pref${i+1}`).join('') + (optOutField ? ', @optout' : ''),
    logDE ? ', @logDE' : '',
    redirectUrl ? ', @redirect' : '',
    `SET @submit = RequestParameter("submit")`,
    `SET @cid = RequestParameter("${identifierField}")`,
    `SET @email = RequestParameter("${emailField}")`,
    ...preferences.map((p, i) => `SET @pref${i+1} = IIF(RequestParameter("${p.fieldApiName}") == "on", "true", "false")`),
    optOutField ? `SET @optout = IIF(RequestParameter("${optOutField}") == "on", "true", "false")` : '',
    logDE ? `SET @logDE = "${logDE}"` : '',
    redirectUrl ? `SET @redirect = "${redirectUrl}"` : ''
  ];
  // Opt-out logic
  if (optOutField) {
    ampscript.push(`IF @optout == "true" THEN`);
    preferences.forEach((p, i) => ampscript.push(`  SET @pref${i+1} = "false"`));
    ampscript.push('ENDIF');
  }
  // Submission logic
  ampscript.push('IF @submit == "Update" THEN');
  // UpsertDE
  ampscript.push(`  UpsertDE("${deName}", 1, "${identifierField}", @cid,`);
  ampscript.push(`    "EmailAddress", @email,`);
  preferences.forEach((p, i) => ampscript.push(`    "${p.fieldApiName}", @pref${i+1},`));
  if (optOutField) ampscript.push(`    "${optOutField}", @optout,`);
  ampscript.push('    "LastUpdated", NOW()');
  ampscript.push('  )');
  // Change log
  if (logDE) {
    ampscript.push(`  InsertDE(@logDE,`);
    ampscript.push(`    "SubscriberKey", @cid,`);
    ampscript.push(`    "EmailAddress", @email,`);
    ampscript.push('    "Old_Value", "N/A",');
    ampscript.push(`    "New_Value", Concat(${preferences.map((p, i) => `"${p.label}=" , @pref${i+1}`).join(', "; ", ')}), "; OptOut=", ${optOutField ? '@optout' : '""'}),`);
    ampscript.push(`    "Subscription", "${config.preferenceCenterName || config.name}",`);
    ampscript.push('    "Error_Message", "",');
    ampscript.push('    "DateModified", NOW()');
    ampscript.push('  )');
  }
  // Redirect or message
  if (redirectUrl) {
    ampscript.push('  Redirect(@redirect)');
  }
  ampscript.push('ENDIF');
  ampscript.push(']%%');
  // HTML form
  let html = `<!DOCTYPE html><html><head><style>body{font-family:Arial;padding:20px;background:#f8f8f8;}h2{color:#004080;}.form-section{background:white;padding:20px;border-radius:6px;max-width:600px;margin:auto;box-shadow:0 0 10px rgba(0,0,0,0.1);}label{display:block;margin-top:15px;font-weight:bold;}.desc{font-size:13px;color:#666;margin-top:4px;}input[type=submit]{background:#004080;color:white;padding:10px 30px;margin-top:20px;border:none;border-radius:4px;cursor:pointer;}</style></head><body><div class='form-section'><h2>${config.preferenceCenterName || config.name || 'Preference Center'}</h2><form method='POST' action='%%=RequestParameter("PAGEURL")=%%'>`;
  html += `<label>Subscriber Identifier (${identifierField})<input type='text' name='${identifierField}' required /></label>`;
  html += `<label>Email Address<input type='email' name='email' required /></label>`;
  preferences.forEach((p, i) => {
    html += `<label><input type='checkbox' name='${p.fieldApiName}'${p.defaultChecked ? ' checked' : ''}/> ${p.label}</label>`;
    if (p.description) html += `<div class='desc'>${p.description}</div>`;
  });
  if (optOutField) {
    html += `<label><input type='checkbox' name='${optOutField}' /> Unsubscribe from all preferences</label>`;
  }
  html += `<input type='submit' name='submit' value='Update' /></form></div></body></html>`;
  return ampscript.join('\n') + '\n' + html;
}


app.post('/preference-center/save-config', async (req, res) => {
  const config = req.body;
  const controllerDEName = 'PC_Controller';
  const logDEName = 'PC_Log';  
  const accessToken = getAccessTokenFromRequest(req);
  const subdomain = getSubdomainFromRequest(req);
  if (!accessToken || !subdomain) {
    return res.status(401).json({ success: false, error: 'Missing accessToken or subdomain' });
  }
  try {
    // 1. Build DE SOAP XML
    const deFields = [
      {
        Name: config.subscriberId || 'EmailAddress',
        FieldType: 'EmailAddress',
        IsRequired: true,
        IsPrimaryKey: true
      },
      ...config.categories.map(cat => ({
        Name: cat.apiName,
        FieldType: 'Boolean',
        IsRequired: false,
        IsPrimaryKey: false
      }))
    ];
    if (config.enableOptOut && config.optOutApiName) {
      deFields.push({
        Name: config.optOutApiName,
        FieldType: 'Boolean',
        IsRequired: false,
        IsPrimaryKey: false
      });
    }
    // Add advanced fields if enabled
    if (config.customFields?.timestamp) {
      deFields.push({ Name: 'Timestamp', FieldType: 'Date', IsRequired: false, IsPrimaryKey: false });
    }
    if (config.customFields?.ip) {
      deFields.push({ Name: 'IP_Address', FieldType: 'Text', IsRequired: false, IsPrimaryKey: false });
    }
    if (config.customFields?.region) {
      deFields.push({ Name: 'Region', FieldType: 'Text', IsRequired: false, IsPrimaryKey: false });
    }
    // Build <Fields> XML
    const fieldsXml = deFields.map(f => `
      <Field>
        <Name>${f.Name}</Name>
        <FieldType>${f.FieldType}</FieldType>
        <IsRequired>${f.IsRequired}</IsRequired>
        <IsPrimaryKey>${f.IsPrimaryKey}</IsPrimaryKey>
      </Field>`).join('');
    // SOAP XML for DE creation
    const deSoapXml = `
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                        xmlns:xsd="http://www.w3.org/2001/XMLSchema">
        <soapenv:Header>
          <fueloauth>${accessToken}</fueloauth>
        </soapenv:Header>
        <soapenv:Body>
          <CreateRequest xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <Options/>
            <Objects xsi:type="DataExtension">
              <CustomerKey>${config.newDeName || config.existingDeName}</CustomerKey>
              <Name>${config.newDeName || config.existingDeName}</Name>
              <Description>Preference Center DE created by MC Explorer</Description>
              <IsSendable>true</IsSendable>
              <SendableDataExtensionField>
                <Name>${config.subscriberId || 'EmailAddress'}</Name>
              </SendableDataExtensionField>
              <SendableSubscriberField>
                <Name>${config.subscriberId === 'SubscriberKey' ? 'Subscriber Key' : 'Email Address'}</Name>
              </SendableSubscriberField>
              <Fields>${fieldsXml}</Fields>
            </Objects>
          </CreateRequest>
        </soapenv:Body>
      </soapenv:Envelope>
    `;
    // 2. Call SOAP API to create DE
    let deResult = null;
    if (config.deOption === 'create') {
      const deResp = await axios.post(
        `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
        deSoapXml,
        {
          headers: {
            'Content-Type': 'text/xml',
            'SOAPAction': 'Create',
            'Authorization': `Bearer ${accessToken}`
          }
        }
      );
      deResult = deResp.data;
    }
    // 3. Generate CloudPage HTML/AMPscript dynamically
    const html = generateCloudPageContent(config);
    // 4. Create CloudPage via REST
    const cloudPagePayload = {
      name: `${config.name || config.preferenceCenterName || 'Preference Center'} - MC Explorer`,
      assetType: { id: 207, name: 'webpage' },
      content: html,
      category: { id: 0 }, // TODO: Lookup or use folder/category ID
      data: { views: { html: { content: html } } }
    };
    const cpResp = await axios.post(
      `https://${subdomain}.rest.marketingcloudapis.com/asset/v1/content/assets`,
      cloudPagePayload,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    // 5. Return results
    res.json({ success: true, deResult, cloudPage: cpResp.data });
  } catch (err) {
    console.error('Preference Center automation error:', err?.response?.data || err);
    res.status(500).json({ success: false, error: err?.response?.data || err.message });
  }
});

// POST /preference-center/project - Accepts full MC project JSON and orchestrates asset creation
app.post('/preference-center/project', async (req, res) => {
  const project = req.body;
  const accessToken = getAccessTokenFromRequest(req);
  const subdomain = getSubdomainFromRequest(req);
  if (!accessToken || !subdomain) {
    return res.status(401).json({ success: false, error: 'Missing access token or subdomain' });
  }
  try {
    // Helper: Resolve template variables in the project JSON
    function resolveVars(str, context) {
      if (typeof str !== 'string') return str;
      return str.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
        const parts = path.replace('mcpm#/', '').split('/');
        let val = context;
        for (const p of parts) val = val?.[p];
        return val ?? '';
      });
    }
    // 1. Create categories/folders first (with dependency order)
    const createdCategories = {};
    if (project.entities.categories) {
      for (const [catId, cat] of Object.entries(project.entities.categories)) {
        // Call MC API to create folder/category if not exists
        // Use cat.data.name, cat.data.categoryType, cat.data.parentId
        // For now, just simulate creation and return the structure
        createdCategories[catId] = { id: catId, ...cat.data };
      }
    }
    // 2. Create Data Extensions (with dependency order)
    const createdDEs = {};
    if (project.entities.dataExtensions) {
      for (const [deId, de] of Object.entries(project.entities.dataExtensions)) {
        // Call MC SOAP API to create DE using de.data
        // Use resolveVars for categoryId and field values
        createdDEs[deId] = { id: deId, ...de.data };
      }
    }
    // 3. Create CloudPages (LandingPages/PrimaryLandingPages)
    const createdPages = {};
    if (project.entities.landingPages) {
      for (const [pageId, page] of Object.entries(project.entities.landingPages)) {
        // Call MC REST API to create CloudPage using page.data.asset
        // Use resolveVars for category.id, content, etc.
        createdPages[pageId] = { id: pageId, ...page.data };
      }
    }
    if (project.entities.primaryLandingPages) {
      for (const [pageId, page] of Object.entries(project.entities.primaryLandingPages)) {
        // Call MC REST API to create CloudPage using page.data.asset
        createdPages[pageId] = { id: pageId, ...page.data };
      }
    }
    // 4. Create Query Activities
    const createdQueries = {};
    if (project.entities.queryActivities) {
      for (const [qId, q] of Object.entries(project.entities.queryActivities)) {
        // Call MC API to create Query Activity using q.data
        createdQueries[qId] = { id: qId, ...q.data };
      }
    }
    // 5. Create Automations
    const createdAutomations = {};
    if (project.entities.automations) {
      for (const [aId, a] of Object.entries(project.entities.automations)) {
        // Call MC API to create Automation using a.data
        createdAutomations[aId] = { id: aId, ...a.data };
      }
    }
    // 6. Return results in the same JSON structure
    res.json({
      ...project,
      orchestrationResult: {
        categories: createdCategories,
        dataExtensions: createdDEs,
        cloudPages: createdPages,
        queryActivities: createdQueries,
        automations: createdAutomations
      },
      message: 'Project orchestration simulated. TODO: Implement actual MC API calls for each asset type.'
    });
  } catch (err) {
    console.error('Project orchestration error:', err);
    res.status(500).json({ success: false, error: err?.message || err });
  }
});

// GET /folders - fetch all folders (for frontend compatibility)
app.get('/folders', async (req, res) => {
  const accessToken = getAccessTokenFromRequest(req);
  const subdomain = getSubdomainFromRequest(req);
  if (!accessToken || !subdomain) {
    return res.status(401).json([]);
  }
  try {
    const folderEnvelope = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <s:Header><fueloauth>${accessToken}</fueloauth></s:Header>
        <s:Body>
          <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <RetrieveRequest>
              <ObjectType>DataFolder</ObjectType>
              <Properties>ID</Properties>
              <Properties>Name</Properties>
              <Properties>ParentFolder.ID</Properties>
              <Properties>ContentType</Properties>
              <Filter xsi:type="SimpleFilterPart">
                <Property>IsActive</Property>
                <SimpleOperator>equals</SimpleOperator>
                <Value>true</Value>
              </Filter>
            </RetrieveRequest>
          </RetrieveRequestMsg>
        </s:Body>
      </s:Envelope>`;
    const folderResp = await axios.post(
      `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
      folderEnvelope,
      { headers: { 'Content-Type': 'text/xml', SOAPAction: 'Retrieve' } }
    );
    const folderParser = new xml2js.Parser({ explicitArray: false });
    let folderMap = {};
    let folders = [];
    await folderParser.parseStringPromise(folderResp.data).then(result => {
      const results = result?.['soap:Envelope']?.['soap:Body']?.['RetrieveResponseMsg']?.['Results'];
      folders = Array.isArray(results) ? results : [results];
      folders.forEach(f => {
        if (f && f.ID) folderMap[String(f.ID)] = f;
      });
    });
    res.json(folders);
  } catch (err) {
    console.error('/folders GET error:', err);
    res.status(500).json({ error: 'Failed to fetch folders' });
  }
});

// EmailSendDefinition Search (SOAP)
app.get('/search/emailsenddefinition', async (req, res) => {
  console.log('🔔 /search/emailsenddefinition endpoint hit'); // DEBUG
  const accessToken = getAccessTokenFromRequest(req);
  const subdomain = getSubdomainFromRequest(req);
  if (!accessToken || !subdomain) {
    return res.status(401).json([]);
  }
  try {
    // Retrieve EmailSendDefinition rows (all relevant properties)
    const props = [
      'Name',
      'CustomerKey',
      'CategoryID',
      'ModifiedDate',
      'SendClassification.CustomerKey',
      'SenderProfile.CustomerKey',
      'DeliveryProfile.CustomerKey',
      'BccEmail',
      'CCEmail'
    ];
    const propsXml = props.map(p => `<Properties>${p}</Properties>`).join('');
    const soapEnvelope = `
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                        xmlns:xsd="http://www.w3.org/2001/XMLSchema">
        <soapenv:Header>
          <fueloauth xmlns="http://exacttarget.com">${accessToken}</fueloauth>
        </soapenv:Header>
        <soapenv:Body>
          <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <RetrieveRequest>
              <ObjectType>EmailSendDefinition</ObjectType>
              ${propsXml}
            </RetrieveRequest>
          </RetrieveRequestMsg>
        </soapenv:Body>
      </soapenv:Envelope>
    `;
    // Log the full SOAP request for debugging
    //console.log("\n[SOAP REQUEST] /search/emailsenddefinition (FINAL):\n" + soapEnvelope);
    const response = await axios.post(
      `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
      soapEnvelope,
      {
        headers: {
          'Content-Type': 'text/xml',
          SOAPAction: 'Retrieve',
        },
      }
    );
    console.log('🔵 Raw EmailSendDefinition SOAP response:', response.data); // DEBUG
    const parser = new xml2js.Parser({ explicitArray: false });
    parser.parseString(response.data, (err, result) => {
      if (err) {
        console.error('❌ Error parsing EmailSendDefinition SOAP response:', err);
        return res.status(500).json([]);
      }
      try {
        const results = result?.['soap:Envelope']?.['soap:Body']?.['RetrieveResponseMsg']?.['Results'];
        if (!results) return res.status(200).json([]);
        const resultArray = Array.isArray(results) ? results : [results];
        const sendDefs = resultArray.map(item => ({
          Name: item.Name || '',
          CustomerKey: item.CustomerKey || '',
          SendClassificationKey: item['SendClassification']?.CustomerKey || item['SendClassification.CustomerKey'] || '',
          SenderProfileKey: item['SenderProfile']?.CustomerKey || item['SenderProfile.CustomerKey'] || '',
          DeliveryProfileKey: item['DeliveryProfile']?.CustomerKey || item['DeliveryProfile.CustomerKey'] || ''
        }));
        res.json(sendDefs);
      } catch (e) {
        console.error('❌ Error parsing EmailSendDefinition SOAP response:', e);
        res.status(500).json([]);
      }
    });
  } catch (e) {
    console.error('❌ Failed to fetch EmailSendDefinition (SOAP):', e.response?.data || e.message);
    res.status(500).json([]);
  }
});

// SenderProfile Search (SOAP)
app.get('/search/senderprofile', async (req, res) => {
  const accessToken = getAccessTokenFromRequest(req);
  const subdomain = getSubdomainFromRequest(req);
  if (!accessToken || !subdomain) return res.status(401).json([]);
  try {
    const soapEnvelope = `
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                        xmlns:xsd="http://www.w3.org/2001/XMLSchema">
        <soapenv:Header>
          <fueloauth xmlns="http://exacttarget.com">${accessToken}</fueloauth>
        </soapenv:Header>
        <soapenv:Body>
          <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <RetrieveRequest>
              <ObjectType>SenderProfile</ObjectType>
              <Properties>CustomerKey</Properties>
              <Properties>Name</Properties>
              <Properties>Description</Properties>
            </RetrieveRequest>
          </RetrieveRequestMsg>
        </soapenv:Body>
      </soapenv:Envelope>
    `;
    const response = await axios.post(
      `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
      soapEnvelope,
      {
        headers: {
          'Content-Type': 'text/xml',
          SOAPAction: 'Retrieve',
        },
      }
    );
    const parser = new xml2js.Parser({ explicitArray: false });
    parser.parseString(response.data, (err, result) => {
      if (err) return res.status(500).json({ error: 'Failed to parse XML' });
      try {
        const results = result?.['soap:Envelope']?.['soap:Body']?.['RetrieveResponseMsg']?.['Results'];
        if (!results) return res.status(200).json([]);
        const arr = Array.isArray(results) ? results : [results];
        const profiles = arr.map(item => ({
          CustomerKey: item.CustomerKey || '',
          Name: item.Name || '',
          Description: item.Description || ''
        }));
        res.json(profiles);
      } catch (e) {
        res.status(500).json([]);
      }
    });
  } catch (e) {
    res.status(500).json([]);
  }
});

// SendClassification Search (SOAP)
app.get('/search/sendclassification', async (req, res) => {
  const accessToken = getAccessTokenFromRequest(req);
  const subdomain = getSubdomainFromRequest(req);
  if (!accessToken || !subdomain) return res.status(401).json([]);
  try {
    const soapEnvelope = `
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                        xmlns:xsd="http://www.w3.org/2001/XMLSchema">
        <soapenv:Header>
          <fueloauth xmlns="http://exacttarget.com">${accessToken}</fueloauth>
        </soapenv:Header>
        <soapenv:Body>
          <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <RetrieveRequest>
              <ObjectType>SendClassification</ObjectType>
              <Properties>CustomerKey</Properties>
              <Properties>Name</Properties>
              <Properties>Description</Properties>
            </RetrieveRequest>
          </RetrieveRequestMsg>
        </soapenv:Body>
      </soapenv:Envelope>
    `;
    const response = await axios.post(
      `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
      soapEnvelope,
      {
        headers: {
          'Content-Type': 'text/xml',
          SOAPAction: 'Retrieve',
        },
      }
    );
    const parser = new xml2js.Parser({ explicitArray: false });
    parser.parseString(response.data, (err, result) => {
      if (err) return res.status(500).json({ error: 'Failed to parse XML' });
      try {
        const results = result?.['soap:Envelope']?.['soap:Body']?.['RetrieveResponseMsg']?.['Results'];
        if (!results) return res.status(200).json([]);
        const arr = Array.isArray(results) ? results : [results];
        const profiles = arr.map(item => ({
          CustomerKey: item.CustomerKey || '',
          Name: item.Name || '',
          Description: item.Description || ''
        }));
        res.json(profiles);
      } catch (e) {
        res.status(500).json([]);
      }
    });
  } catch (e) {
    res.status(500).json([]);
  }
});

// DeliveryProfile Search (SOAP)
app.get('/search/deliveryprofile', async (req, res) => {
  const accessToken = getAccessTokenFromRequest(req);
  const subdomain = getSubdomainFromRequest(req);
  if (!accessToken || !subdomain) return res.status(401).json([]);
  try {
    const soapEnvelope = `
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                        xmlns:xsd="http://www.w3.org/2001/XMLSchema">
        <soapenv:Header>
          <fueloauth xmlns="http://exacttarget.com">${accessToken}</fueloauth>
        </soapenv:Header>
        <soapenv:Body>
          <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <RetrieveRequest>
              <ObjectType>DeliveryProfile</ObjectType>
              <Properties>CustomerKey</Properties>
              <Properties>Name</Properties>
              <Properties>Description</Properties>
            </RetrieveRequest>
          </RetrieveRequestMsg>
        </soapenv:Body>
      </soapenv:Envelope>
    `;
    const response = await axios.post(
      `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
      soapEnvelope,
      {
        headers: {
          'Content-Type': 'text/xml',
          SOAPAction: 'Retrieve',
        },
      }
    );
    const parser = new xml2js.Parser({ explicitArray: false });
    parser.parseString(response.data, (err, result) => {
      if (err) return res.status(500).json({ error: 'Failed to parse XML' });
      try {
        const results = result?.['soap:Envelope']?.['soap:Body']?.['RetrieveResponseMsg']?.['Results'];
        if (!results) return res.status(200).json([]);
        const arr = Array.isArray(results) ? results : [results];
        const profiles = arr.map(item => ({
          CustomerKey: item.CustomerKey || '',
          Name: item.Name || '',
          Description: item.Description || ''
        }));
        res.json(profiles);
      } catch (e) {
        res.status(500).json([]);
      }
    });
  } catch (e) {
    res.status(500).json([]);
  }
});

// Update EmailSendDefinition SenderProfile (SOAP)
app.post('/update/emailsenddefinition-senderprofile', async (req, res) => {
  const { customerKey, newSenderProfileKey } = req.body;
  const accessToken = getAccessTokenFromRequest(req);
  const subdomain = getSubdomainFromRequest(req);
  if (!accessToken || !subdomain) return res.status(401).json({ error: 'Unauthorized' });
  if (!customerKey || !newSenderProfileKey) return res.status(400).json({ error: 'Missing parameters' });
  try {
    const soapEnvelope = `
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                        xmlns:xsd="http://www.w3.org/2001/XMLSchema">
        <soapenv:Header>
          <fueloauth xmlns="http://exacttarget.com">${accessToken}</fueloauth>
        </soapenv:Header>
        <soapenv:Body>
          <UpdateRequest xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <Objects xsi:type="EmailSendDefinition">
              <CustomerKey>${customerKey}</CustomerKey>
              <SenderProfile>
                <CustomerKey>${newSenderProfileKey}</CustomerKey>
              </SenderProfile>
            </Objects>
          </UpdateRequest>
        </soapenv:Body>
      </soapenv:Envelope>
    `;
    const response = await axios.post(
      `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
      soapEnvelope,
      {
        headers: {
          'Content-Type': 'text/xml',
          SOAPAction: 'Update',
        },
      }
    );
    // Parse response for status
    const parser = new xml2js.Parser({ explicitArray: false });
    parser.parseString(response.data, (err, result) => {
      if (err) return res.status(500).json({ error: 'Failed to parse XML' });
      const status = result?.['soap:Envelope']?.['soap:Body']?.['UpdateResponse']?.['OverallStatus'];
      if (status && status.toLowerCase().includes('ok')) {
        res.json({ success: true });
      } else {
        res.status(500).json({ error: 'Update failed', details: status });
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update EmailSendDefinition (single record, SOAP)
app.post('/update/emailsenddefinition', async (req, res) => {
  const { CustomerKey, SendClassification, SenderProfile, DeliveryProfile, BccEmail, CCEmail } = req.body;
  const accessToken = getAccessTokenFromRequest(req);
  const subdomain = getSubdomainFromRequest(req);
  if (!accessToken || !subdomain) return res.status(401).json({ error: 'Unauthorized' });
  if (!CustomerKey) return res.status(400).json({ error: 'Missing CustomerKey' });
  try {
    // Log the incoming payload for debugging
    console.log('🔵 [Update ESD] Payload:', req.body);
    const soapEnvelope = `
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <soapenv:Header>
          <fueloauth xmlns="http://exacttarget.com">${accessToken}</fueloauth>
        </soapenv:Header>
        <soapenv:Body>
          <UpdateRequest xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <Objects xsi:type="EmailSendDefinition">
              <CustomerKey>${CustomerKey}</CustomerKey>
              ${SendClassification ? `<SendClassification><CustomerKey>${SendClassification}</CustomerKey></SendClassification>` : ''}
              ${SenderProfile ? `<SenderProfile><CustomerKey>${SenderProfile}</CustomerKey></SenderProfile>` : ''}
              ${DeliveryProfile ? `<DeliveryProfile><CustomerKey>${DeliveryProfile}</CustomerKey></DeliveryProfile>` : ''}
              <BccEmail>${BccEmail || ''}</BccEmail>
              <CCEmail>${CCEmail || ''}</CCEmail>
            </Objects>
          </UpdateRequest>
        </soapenv:Body>
      </soapenv:Envelope>
    `;
    // Log the SOAP envelope for debugging
    console.log('🔵 [Update ESD] SOAP Envelope:', soapEnvelope);
    const response = await axios.post(
      `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
      soapEnvelope,
      {
        headers: {
          'Content-Type': 'text/xml',
          SOAPAction: 'Update',
        },
      }
    );
    // Log the raw SOAP response
    console.log('🔵 [Update ESD] SOAP Response:', response.data);
    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(response.data);
    const status = result?.['soap:Envelope']?.['soap:Body']?.['UpdateResponse']?.['OverallStatus'];
    const statusMessage = result?.['soap:Envelope']?.['soap:Body']?.['UpdateResponse']?.['Results']?.['StatusMessage'];
    if (status && status.toLowerCase().includes('ok')) {
      res.json({ status: 'OK' });
    } else {
      // User-friendly error for V5 Customers restriction
      if (statusMessage && statusMessage.includes('V5 Customers cannot update User-Initiated Sends with Salesforce Reports or Campaigns')) {
        return res.status(400).json({
          status: 'ERROR',
          message: 'This EmailSendDefinition cannot be updated via API because it is a User-Initiated Send tied to Salesforce Reports or Campaigns. This is a Salesforce platform restriction.'
        });
      }
      console.error('❌ [Update ESD] SOAP Error:', status, result);
      res.status(500).json({ status: 'ERROR', message: statusMessage || status });
    }
  } catch (e) {
    console.error('❌ [Update ESD] Exception:', e.response?.data || e.message, e.stack);
    res.status(500).json({ status: 'ERROR', message: e.message });
  }
});

// Bulk update EmailSendDefinition (SOAP)
app.post('/update/emailsenddefinition-mass', async (req, res) => {
  const { CustomerKeys, SendClassification, SenderProfile, DeliveryProfile, BccEmail, CCEmail } = req.body;
  const accessToken = getAccessTokenFromRequest(req);
  const subdomain = getSubdomainFromRequest(req);
  if (!accessToken || !subdomain) return res.status(401).json({ error: 'Unauthorized' });
  if (!Array.isArray(CustomerKeys) || CustomerKeys.length === 0) return res.status(400).json({ error: 'No CustomerKeys provided' });
  try {
    // Build SOAP body for multiple updates
    const objectsXml = CustomerKeys.map(key => `
      <Objects xsi:type="EmailSendDefinition">
        <CustomerKey>${key}</CustomerKey>
        ${SendClassification ? `<SendClassification><CustomerKey>${SendClassification}</CustomerKey></SendClassification>` : ''}
        ${SenderProfile ? `<SenderProfile><CustomerKey>${SenderProfile}</CustomerKey></SenderProfile>` : ''}
        ${DeliveryProfile ? `<DeliveryProfile><CustomerKey>${DeliveryProfile}</CustomerKey></DeliveryProfile>` : ''}
        <BccEmail>${BccEmail || ''}</BccEmail>
        <CCEmail>${CCEmail || ''}</CCEmail>
      </Objects>
    `).join('');
    const soapEnvelope = `
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <soapenv:Header>
          <fueloauth>${accessToken}</fueloauth>
        </soapenv:Header>
        <soapenv:Body>
          <UpdateRequest xmlns="http://exacttarget.com/wsdl/partnerAPI">
            ${objectsXml}
          </UpdateRequest>
        </soapenv:Body>
      </soapenv:Envelope>
    `;
    const response = await axios.post(
      `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
      soapEnvelope,
      {
        headers: {
          'Content-Type': 'text/xml',
          SOAPAction: 'Update',
        },
      }
    );
    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(response.data);
    const status = result?.['soap:Envelope']?.['soap:Body']?.['UpdateResponse']?.['OverallStatus'];
    if (status && status.toLowerCase().includes('ok')) {
      res.json({ status: 'OK' });
    } else {
      res.status(500).json({ status: 'ERROR', message: status });
    }
  } catch (e) {
    res.status(500).json({ status: 'ERROR', message: e.message });
  }
});

// Parse EmailSendDefinition config and extract relationships
app.post('/parse/emailsenddefinition-config', (req, res) => {
  const config = req.body;
  if (!config || !config.entities || !config.input) {
    return res.status(400).json({ error: 'Invalid config format' });
  }
  const sendDefs = config.entities.sendDefinitions || {};
  const inputArr = config.input || [];

  // Build a lookup for input keys
  const inputKeyMap = {};
  inputArr.forEach(inp => {
    inputKeyMap[inp.key] = inp;
  });

  // Parse each sendDefinition
  const result = Object.entries(sendDefs).map(([defId, defObj]) => {
    const data = defObj.data || {};
    // The IDs are references like {{mcpm:senderProfile}}
    const senderProfileKey = data.senderProfileId || '';
    const sendClassificationKey = data.sendClassificationId || '';
    const deliveryProfileKey = data.deliveryProfileId || '';

    // Map to input keys (strip {{mcpm: and }})
    const senderProfileInputKey = senderProfileKey.replace(/\{\{mcpm:|}}/g, '');
    const sendClassificationInputKey = sendClassificationKey.replace(/\{\{mcpm:|}}/g, '');
    const deliveryProfileInputKey = deliveryProfileKey.replace(/\{\{mcpm:|}}/g, '');

    // Find the input object for each
    const senderProfileInput = inputKeyMap[senderProfileInputKey] || null;
    const sendClassificationInput = inputKeyMap[sendClassificationInputKey] || null;
    const deliveryProfileInput = inputKeyMap[deliveryProfileInputKey] || null;

    return {
      sendDefinitionId: defId,
      name: data.name || data.Name || '',
      key: data.key || data.CustomerKey || '',
      senderProfile: senderProfileInput ? senderProfileInput.meta.entityType : null,
      senderProfileKey: senderProfileInputKey,
      sendClassification: sendClassificationInput ? sendClassificationInput.meta.entityType : null,
      sendClassificationKey: sendClassificationInputKey,
      deliveryProfile: deliveryProfileInput ? deliveryProfileInput.meta.entityType : null,
    };
  });

  res.json(result);
});

// Resolved EmailSendDefinition relationships endpoint (enrich with full details for all related objects)
app.get('/resolved/emailsenddefinition-relationships', async (req, res) => {
  const accessToken = getAccessTokenFromRequest(req);
  const subdomain = getSubdomainFromRequest(req);
  if (!accessToken || !subdomain) return res.status(401).json([]);
  try {
      
       // Helper to fetch SOAP objects by CustomerKey
   
    async function fetchSoapByCustomerKeys(objectType, properties, customerKeys) {
      if (!customerKeys.length) return {};
      // Batch in groups of 20 (SOAP limit)
      const batches = [];
      for (let i = 0; i < customerKeys.length; i += 20) {
        batches.push(customerKeys.slice(i, i + 20));
      }
      let allResults = [];
      for (const batch of batches) {
        const propsXml = properties.map(p => `<Properties>${p}</Properties>`).join('');
        const filterXml = `
          <Filter xsi:type=\"SimpleFilterPart\">
            <Property>CustomerKey</Property>
            <SimpleOperator>IN</SimpleOperator>
            ${batch.map(k => `<Value>${k}</Value>`).join('')}
          </Filter>
        `;
        const soapEnvelope = `
          <soapenv:Envelope xmlns:soapenv=\"http://schemas.xmlsoap.org/soap/envelope/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">
            <soapenv:Header>
              <fueloauth xmlns=\"http://exacttarget.com\">${accessToken}</fueloauth>
            </soapenv:Header>
            <soapenv:Body>
              <RetrieveRequestMsg xmlns=\"http://exacttarget.com/wsdl/partnerAPI\">
                <RetrieveRequest>
                  <ObjectType>${objectType}</ObjectType>
                  ${propsXml}
                  ${filterXml}
                </RetrieveRequest>
              </RetrieveRequestMsg>
            </soapenv:Body>
          </soapenv:Envelope>
        `;
        const response = await axios.post(
          `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
          soapEnvelope,
          { headers: { 'Content-Type': 'text/xml', SOAPAction: 'Retrieve' } }
        );
        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(response.data);
        const results = result?.['soap:Envelope']?.['soap:Body']?.['RetrieveResponseMsg']?.['Results'];
        if (results) {
          allResults = allResults.concat(Array.isArray(results) ? results : [results]);
        }
      }
      // Map by CustomerKey
      const map = {};
      allResults.forEach(obj => { if (obj.CustomerKey) map[obj.CustomerKey] = obj; });
      return map;
    }

    // Step 1: Fetch all EmailSendDefinitions
    const sendDefs = await (async () => {
      const props = [
        'Name',
        'CustomerKey',
        'CategoryID',
        'ModifiedDate',
        'SendClassification.CustomerKey',
        'SenderProfile.CustomerKey',
        'DeliveryProfile.CustomerKey',
        'BccEmail',
        'CCEmail'
      ];
      const propsXml = props.map(p => `<Properties>${p}</Properties>`).join('');
      const soapEnvelope = `
        <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
          <soapenv:Header>
            <fueloauth xmlns="http://exacttarget.com">${accessToken}</fueloauth>
          </soapenv:Header>
          <soapenv:Body>
            <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
              <RetrieveRequest>
                <ObjectType>EmailSendDefinition</ObjectType>
                ${propsXml}
              </RetrieveRequest>
            </RetrieveRequestMsg>
          </soapenv:Body>
        </soapenv:Envelope>
      `;
      // Print the SOAP request envelope for debugging (no escaping)
      console.log("\n[SOAP REQUEST] EmailSendDefinition Retrieve (FINAL):\n" + soapEnvelope);
      const response = await axios.post(
        `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
        soapEnvelope,
        { headers: { 'Content-Type': 'text/xml', SOAPAction: 'Retrieve' } }
      );
      const parser = new xml2js.Parser({ explicitArray: false });
      const result = await parser.parseStringPromise(response.data);
      const results = result?.['soap:Envelope']?.['soap:Body']?.['RetrieveResponseMsg']?.['Results'];
      // Always return array, and include full nested objects
      const arr = results ? (Array.isArray(results) ? results : [results]) : [];
      return arr.map(item => ({
        Name: item.Name,
        CustomerKey: item.CustomerKey,
        CategoryID: item.CategoryID,
        ModifiedDate: item.ModifiedDate,
        SendClassificationKey: item['SendClassification']?.CustomerKey || item['SendClassification.CustomerKey'] || '',
        SenderProfileKey: item['SenderProfile']?.CustomerKey || item['SenderProfile.CustomerKey'] || '',
        DeliveryProfileKey: item['DeliveryProfile']?.CustomerKey || item['DeliveryProfile.CustomerKey'] || '',
        BccEmail: item.BccEmail || '',
        CCEmail: item.CCEmail || ''
      }));
    })();

    // Step 2: Collect all unique CustomerKeys for related objects
    const sendClassKeys = Array.from(new Set(sendDefs.map(d => d.SendClassificationKey).filter(Boolean)));
    const senderProfileKeys = Array.from(new Set(sendDefs.map(d => d.SenderProfileKey).filter(Boolean)));
    const deliveryProfileKeys = Array.from(new Set(sendDefs.map(d => d.DeliveryProfileKey).filter(Boolean)));

    // Step 3: Fetch details for all related objects
    const [sendClassMap, senderProfileMap, deliveryProfileMap] = await Promise.all([
      fetchSoapByCustomerKeys('SendClassification', ['CustomerKey', 'Name', 'Description', 'SenderProfile.CustomerKey', 'DeliveryProfile.CustomerKey'], sendClassKeys),
      fetchSoapByCustomerKeys('SenderProfile', ['CustomerKey', 'Name', 'Description'], senderProfileKeys),
      fetchSoapByCustomerKeys('DeliveryProfile', ['CustomerKey', 'Name', 'Description'], deliveryProfileKeys)
    ]);

    // Step 4: Enrich each EmailSendDefinition with full details
    const resolved = sendDefs.map(def => {
      const sendClass = sendClassMap[def.SendClassificationKey] || {};
      const senderProfile = senderProfileMap[def.SenderProfileKey] || {};
      const deliveryProfile = deliveryProfileMap[def.DeliveryProfileKey] || {};
      return {
        Name: def.Name,
        CustomerKey: def.CustomerKey,
        CategoryID: def.CategoryID,
        ModifiedDate: def.ModifiedDate || '',
        BccEmail: def.BccEmail || '',
        CCEmail: def.CCEmail || '',
        SendClassification: {
          CustomerKey: def.SendClassificationKey,
          Name: sendClass.Name || '',
          Description: sendClass.Description || '',
          SenderProfileKey: sendClass['SenderProfile']?.CustomerKey || sendClass['SenderProfile.CustomerKey'] || '',
          DeliveryProfileKey: sendClass['DeliveryProfile']?.CustomerKey || sendClass['DeliveryProfile.CustomerKey'] || ''
        },
        SenderProfile: {
          CustomerKey: def.SenderProfileKey,
          Name: senderProfile.Name || '',
          Description: senderProfile.Description || ''
        },
        DeliveryProfile: {
          CustomerKey: def.DeliveryProfileKey,
          Name: deliveryProfile.Name || '',
          Description: deliveryProfile.Description || ''
        }
      };
    });
    res.json(resolved);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Describe SOAP object and print retrievable properties
app.get('/describe-soap-object', async (req, res) => {
  const accessToken = getAccessTokenFromRequest(req);
  const subdomain = getSubdomainFromRequest(req);
  const objectType = req.query.objectType;
  if (!accessToken || !subdomain || !objectType) return res.status(400).json({ error: 'Missing required parameters' });
  try {
    const soapEnvelope = `
      <soapenv:Envelope xmlns:soapenv=\"http://schemas.xmlsoap.org/soap/envelope/\">
        <soapenv:Header>
          <fueloauth xmlns=\"http://exacttarget.com\">${accessToken}</fueloauth>
        </soapenv:Header>
        <soapenv:Body>
          <DescribeRequestMsg xmlns=\"http://exacttarget.com/wsdl/partnerAPI\">
            <DescribeRequests>
              <ObjectDefinitionRequest>
                <ObjectType>${objectType}</ObjectType>
              </ObjectDefinitionRequest>
            </DescribeRequests>
          </DescribeRequestMsg>
        </soapenv:Body>
      </soapenv:Envelope>
    `;
    const response = await axios.post(
      `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
      soapEnvelope,
      {
        headers: {
          'Content-Type': 'text/xml',
          'SOAPAction': 'Describe',
        },
      }
    );
    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(response.data);
    const objDef = result?.['soap:Envelope']?.['soap:Body']?.['DescribeResponseMsg']?.['ObjectDefinition'] || {};
    let props = objDef?.Properties?.PropertyDefinition || [];
    if (!Array.isArray(props)) props = [props];
    const retrievableProps = props.filter(p => p.IsRetrievable === 'true' || p.IsRetrievable === true);
    //console.log(`\n[SOAP Describe] Retrievable properties for ${objectType}:`);
    retrievableProps.forEach(p => console.log(`- ${p.Name}`));
    res.json({
      objectType,
      retrievableProperties: retrievableProps.map(p => p.Name),
      allProperties: props.map(p => ({
        Name: p.Name,
        IsRetrievable: p.IsRetrievable,
        IsUpdatable: p.IsUpdatable,
        IsCreatable: p.IsCreatable,
        IsFilterable: p.IsFilterable,
        IsNullable: p.IsNullable
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Endpoint to check if backend has credentials (per session)
app.get('/has-credentials', (req, res) => {
  const creds = req.session.mcCreds || {};
  console.log('🟢 /has-credentials (session) check:', creds);
  const hasCreds = !!(creds.subdomain && creds.clientId && creds.clientSecret);
  res.json({ hasCreds });
});

// Publication Search (SOAP)
app.get('/search/publication', async (req, res) => {
  const accessToken = req.session.accessToken;
  const subdomain = req.session.mcCreds && req.session.mcCreds.subdomain;
  if (!accessToken || !subdomain) {
    return res.status(401).json([]);
  }
  try {
    const soapEnvelope = `
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                        xmlns:xsd="http://www.w3.org/2001/XMLSchema">
        <soapenv:Header>
          <fueloauth xmlns="http://exacttarget.com">${accessToken}</fueloauth>
        </soapenv:Header>
        <soapenv:Body>
          <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <RetrieveRequest>
              <ObjectType>Publication</ObjectType>
              <Properties>ID</Properties>
              <Properties>Name</Properties>
              <Properties>Category</Properties>
            </RetrieveRequest>
          </RetrieveRequestMsg>
        </soapenv:Body>
      </soapenv:Envelope>
    `;
    // Log the SOAP envelope for debugging
    console.log('🔵 [Publication] SOAP Envelope:', soapEnvelope);
    try {
      const response = await axios.post(
        `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
        soapEnvelope,
        {
          headers: {
            'Content-Type': 'text/xml',
            SOAPAction: 'Retrieve',
          },
        }
      );
      // Log the raw SOAP response
      console.log('🔵 [Publication] SOAP Response:', response.data);
      const parser = new xml2js.Parser({ explicitArray: false });
      parser.parseString(response.data, (err, result) => {
        if (err) {
          console.error('❌ [Publication] Failed to parse XML:', err);
          return res.status(500).json({ error: 'Failed to parse XML' });
        }
        try {
          const results = result?.['soap:Envelope']?.['soap:Body']?.['RetrieveResponseMsg']?.['Results'];
          if (!results) return res.status(200).json([]);
          const resultArray = Array.isArray(results) ? results : [results];
          const pubs = resultArray.map(pub => ({
            id: pub.ID || '',
            name: pub.Name || '',
            category: pub.Category || ''
          }));
          res.json(pubs);
        } catch (e) {
          console.error('❌ [Publication] Unexpected format:', e);
          res.status(500).json({ error: 'Unexpected Publication format' });
        }
      });
    } catch (err) {
      // Log the error response body if available
      if (err.response && err.response.data) {
        console.error('❌ [Publication] SOAP Error Response:', err.response.data);
      } else {
        console.error('❌ [Publication] Request Error:', err.message);
      }
      res.status(500).json({ error: 'Failed to fetch Publications' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch Publications' });
  }
});

// Create Distributed Marketing Data Extension and folder
// Create Distributed Marketing Data Extension and folder
app.post('/create/dm-dataextension', async (req, res) => {
  const accessToken = req.session.accessToken;
  const subdomain = req.session.mcCreds && req.session.mcCreds.subdomain;
  if (!accessToken || !subdomain) return res.status(401).json({ status: 'ERROR', message: 'Unauthorized' });
  try {
    const axios = require('axios');
    const xml2js = require('xml2js');
    const parser = new xml2js.Parser({ explicitArray: false });

    // Step 1: Get root folder for dataextension
    const getRootFolderSoap = `
  <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <soapenv:Header>
      <fueloauth xmlns="http://exacttarget.com">${accessToken}</fueloauth>
    </soapenv:Header>
    <soapenv:Body>
      <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
        <RetrieveRequest>
          <ObjectType>DataFolder</ObjectType>
          <Properties>ID</Properties>
          <Properties>Name</Properties>
          <Properties>ContentType</Properties>
          <Properties>ParentFolder.ID</Properties>
          <Filter xsi:type="SimpleFilterPart">
            <Property>ContentType</Property>
            <SimpleOperator>equals</SimpleOperator>
            <Value>dataextension</Value>
          </Filter>
        </RetrieveRequest>
      </RetrieveRequestMsg>
    </soapenv:Body>
  </soapenv:Envelope>
`;


    const rootResp = await axios.post(
      `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
      getRootFolderSoap,
      { headers: { 'Content-Type': 'text/xml', SOAPAction: 'Retrieve' } }
    );

    const rootParsed = await parser.parseStringPromise(rootResp.data);
    const rootFolders = rootParsed?.['soap:Envelope']?.['soap:Body']?.['RetrieveResponseMsg']?.['Results'];

let parentId = null;

if (Array.isArray(rootFolders)) {
  const rootDEFolder = rootFolders.find(f => f.ContentType === 'dataextension' && f['ParentFolder']?.ID === '0');
  parentId = rootDEFolder?.ID;
} else if (rootFolders?.ContentType === 'dataextension' && rootFolders?.ParentFolder?.ID === '0') {
  parentId = rootFolders.ID;
}


    if (!parentId) return res.status(500).json({ status: 'ERROR', message: 'Root folder for dataextensions not found' });

     // Step 2: Try to find folder first
    const folderName = `MC-Explorer-DM-${Date.now()}`;
    let folderId = null;
    const folderSoap = `
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <soapenv:Header>
          <fueloauth>${accessToken}</fueloauth>
        </soapenv:Header>
        <soapenv:Body>
          <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <RetrieveRequest>
              <ObjectType>DataFolder</ObjectType>
              <Properties>ID</Properties>
              <Properties>Name</Properties>
              <Properties>ContentType</Properties>
              <Filter>
                <Property>Name</Property>
                <SimpleOperator>equals</SimpleOperator>
                <Value>${folderName}</Value>
              </Filter>
            </RetrieveRequest>
          </RetrieveRequestMsg>
        </soapenv:Body>
      </soapenv:Envelope>
    `;

    const folderResp = await axios.post(
      `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
      folderSoap,
      { headers: { 'Content-Type': 'text/xml', SOAPAction: 'Retrieve' } }
    );

    const folderResult = await parser.parseStringPromise(folderResp.data);
    const folderResults = folderResult?.['soap:Envelope']?.['soap:Body']?.['RetrieveResponseMsg']?.['Results'];

    if (folderResults && folderResults.ID) {
      folderId = folderResults.ID;
    } else if (Array.isArray(folderResults) && folderResults.length > 0) {
      folderId = folderResults[0].ID;
    }
      // Step 3: Create folder if not found
    if (!folderId) {
      console.log('[Resolved Root DataExtension Folder ID]', parentId);

      const createFolderSoap = `
  <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <soapenv:Header>
      <fueloauth>${accessToken}</fueloauth>
    </soapenv:Header>
    <soapenv:Body>
      <CreateRequest xmlns="http://exacttarget.com/wsdl/partnerAPI">
        <Options/>
        <Objects xsi:type="DataFolder">
         <!-- <CustomerKey>${folderName}</CustomerKey> -->
          <Name>${folderName}</Name>
          <Description>${folderName}</Description>
          <ContentType>dataextension</ContentType>
          <IsActive>true</IsActive>
          <IsEditable>true</IsEditable>
          <AllowChildren>true</AllowChildren>
          <ParentFolder>
            <ID>${parentId}</ID>
            <ObjectID xsi:nil="true"/>
            <CustomerKey xsi:nil="true"/>
          </ParentFolder>
        </Objects>
      </CreateRequest>
    </soapenv:Body>
  </soapenv:Envelope>
`;


      const createFolderResp = await axios.post(
        `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
        createFolderSoap,
        { headers: { 'Content-Type': 'text/xml', SOAPAction: 'Create' } }
      );
console.log('[SOAP Folder Create Raw]', createFolderResp.data);
      const createFolderResult = await parser.parseStringPromise(createFolderResp.data);
      folderId = createFolderResult?.['soap:Envelope']?.['soap:Body']?.['CreateResponse']?.['Results']?.['NewID'];
    }



    if (!folderId) return res.status(500).json({ status: 'ERROR', message: 'Failed to create or find folder' });

    // 2. Create Data Extension with correct fields
    const now = new Date();
    const pad = n => n.toString().padStart(2, '0');
    const dtStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const deName = `DM_MC_explorer_${dtStr}`;
    const deSoap = `
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <soapenv:Header>
          <fueloauth>${accessToken}</fueloauth>
        </soapenv:Header>
        <soapenv:Body>
          <CreateRequest xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <Options />
            <Objects xmlns:ns1="http://exacttarget.com/wsdl/partnerAPI" xsi:type="ns1:DataExtension">
              <Name>${deName}</Name>
              <CustomerKey>${deName}</CustomerKey>
              <CategoryID>${folderId}</CategoryID>
              <IsSendable>true</IsSendable>
              <IsTestable>true</IsTestable>
              <Fields>
                <Field><Name>greeting</Name><FieldType>Text</FieldType><MaxLength>100</MaxLength><IsRequired>false</IsRequired></Field>
                <Field><Name>id</Name><FieldType>Text</FieldType><MaxLength>36</MaxLength><IsPrimaryKey>true</IsPrimaryKey><IsRequired>true</IsRequired></Field>
                <Field><Name>email</Name><FieldType>EmailAddress</FieldType><MaxLength>254</MaxLength><IsPrimaryKey>false</IsPrimaryKey><IsRequired>false</IsRequired></Field>
                <Field><Name>sfCampaignId</Name><FieldType>Text</FieldType><MaxLength>36</MaxLength><IsRequired>false</IsRequired></Field>
                <Field><Name>sfCampaignMemberId</Name><FieldType>Text</FieldType><MaxLength>36</MaxLength><IsRequired>false</IsRequired></Field>
                <Field><Name>sfQuickSendId</Name><FieldType>Text</FieldType><MaxLength>36</MaxLength><IsRequired>false</IsRequired></Field>
                <Field><Name>sendFromName</Name><FieldType>Text</FieldType><MaxLength>100</MaxLength><IsRequired>false</IsRequired></Field>
                <Field><Name>sendFromEmail</Name><FieldType>Text</FieldType><MaxLength>100</MaxLength><IsRequired>false</IsRequired></Field>
                <Field><Name>firstName</Name><FieldType>Text</FieldType><MaxLength>100</MaxLength><IsRequired>false</IsRequired></Field>
                <Field><Name>lastName</Name><FieldType>Text</FieldType><MaxLength>100</MaxLength><IsRequired>false</IsRequired></Field>
                <Field><Name>sfUserId</Name><FieldType>Text</FieldType><MaxLength>36</MaxLength><IsRequired>false</IsRequired></Field>
                <Field><Name>journeyID</Name><FieldType>Text</FieldType><MaxLength>50</MaxLength><IsRequired>false</IsRequired></Field>
                <Field><Name>sfOrgId</Name><FieldType>Text</FieldType><MaxLength>50</MaxLength><IsRequired>false</IsRequired></Field>
                <Field><Name>DateEntered</Name><FieldType>Date</FieldType><IsRequired>false</IsRequired><DefaultValue>GETDATE()</DefaultValue></Field>
                <Field><Name>smsValue</Name><FieldType>Text</FieldType><MaxLength>160</MaxLength><IsRequired>false</IsRequired></Field>
                <Field><Name>mobilePhone</Name><FieldType>Phone</FieldType><MaxLength>50</MaxLength><IsRequired>false</IsRequired></Field>
                <Field><Name>EntryObjectId</Name><FieldType>Text</FieldType><MaxLength>36</MaxLength><IsRequired>false</IsRequired></Field>
              </Fields>
                <SendableDataExtensionField>
                  <Name>id</Name>
                </SendableDataExtensionField>
                <SendableSubscriberField>
                  <Name>Subscriber Key</Name>
                </SendableSubscriberField>
            </Objects>
          </CreateRequest>
        </soapenv:Body>
      </soapenv:Envelope>
    `;
    const deResp = await axios.post(
      `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
      deSoap,
      { headers: { 'Content-Type': 'text/xml', SOAPAction: 'Create' } }
    );
    
    // Log the raw response for debugging
    console.log('[SOAP DE Create Raw]', deResp.data);
    
    const deParsed = await parser.parseStringPromise(deResp.data);
    
    // Get the overall status and any error messages
    const overallStatus = deParsed?.['soap:Envelope']?.['soap:Body']?.['CreateResponse']?.['OverallStatus'];
    const results = deParsed?.['soap:Envelope']?.['soap:Body']?.['CreateResponse']?.['Results'];
    const statusMsg = results?.StatusMessage;
    const errorCode = results?.ErrorCode;
    
    console.log('[DE Creation Response]', { overallStatus, statusMsg, errorCode });

    if (overallStatus !== 'OK' || (errorCode && errorCode !== '0')) {
      console.error('[DE Creation Failed]', { statusMsg, overallStatus, errorCode });
      return res.status(500).json({ 
        status: 'ERROR', 
        message: 'Failed to create Data Extension', 
        details: statusMsg || overallStatus 
      });
    }

    // Step 5: Get DE ObjectID using SOAP
    const deRetrieveSoap = `
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <soapenv:Header>
          <fueloauth>${accessToken}</fueloauth>
        </soapenv:Header>
        <soapenv:Body>
          <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <RetrieveRequest>
              <ObjectType>DataExtension</ObjectType>
              <Properties>ObjectID</Properties>
              <Properties>Name</Properties>
              <Filter xsi:type="SimpleFilterPart">
                <Property>Name</Property>
                <SimpleOperator>equals</SimpleOperator>
                <Value>${deName}</Value>
              </Filter>
            </RetrieveRequest>
          </RetrieveRequestMsg>
        </soapenv:Body>
      </soapenv:Envelope>
    `;

    const retrieveResp = await axios.post(
      `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`,
      deRetrieveSoap,
      { headers: { 'Content-Type': 'text/xml', SOAPAction: 'Retrieve' } }
    );
    
    console.log('[DE Retrieve Response]', retrieveResp.data);
    
    const retrieveParsed = await parser.parseStringPromise(retrieveResp.data);
    const deObjectID = retrieveParsed?.['soap:Envelope']?.['soap:Body']?.['RetrieveResponseMsg']?.['Results']?.ObjectID;

    if (!deObjectID) {
      console.error('[DE ObjectID Retrieval Failed]', retrieveParsed);
      return res.status(500).json({ status: 'ERROR', message: 'Failed to retrieve DE ObjectID' });
    }

    console.log('[Retrieved DE ObjectID]', deObjectID);

    // Step 6: Create Event Definition with correct ObjectID
    const eventDtStr = new Date().toISOString().replace(/[:\-\.]/g, '').slice(0, 14);
    const eventKey = `dm_event_${eventDtStr}`;
    const eventName = `DM Event Definition - ${eventDtStr}`;
    // Create API Event Definition with proper format
    const eventDefPayload = {
      name: `DM Event Definition - ${eventDtStr}`,
      type: "APIEvent",
      dataExtensionId: deObjectID,
      description: `Triggered DE for ${deName}`,
      eventDefinitionKey: eventKey,
      mode: "Production",
      iconUrl: "/images/icon_journeyBuilder-event-api-blue.svg",
      isVisibleInPicker: false,
      category: "Event",
      disableDEDataLogging: false,
      isPlatformObject: false,
      metaData: {
        scheduleState: "No Schedule"
      },
      arguments: {
        serializedObjectType: 11,
        eventDefinitionId: "",
        eventDefinitionKey: eventKey,
        dataExtensionId: deObjectID,
        criteria: ""
      },
      sourceApplicationExtensionId: "7db1f972-f8b7-49b6-91b5-fa218e13953d"
    };

    console.log('[Creating Event Definition with payload]', JSON.stringify(eventDefPayload, null, 2));
    
    const eventDefResp = await axios.post(
      `https://${subdomain}.rest.marketingcloudapis.com/interaction/v1/eventDefinitions`,
      eventDefPayload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('[Created Event Definition]', eventDefResp.data);

    if (!eventDefResp.data.id) {
      throw new Error('Event Definition creation failed - no ID returned');
    }

    const eventDefinitionId = eventDefResp.data.id;
    console.log(`[Event Definition created with ID: ${eventDefinitionId}]`);

    // Step 6: Create Journey for Distributed Marketing
    await new Promise(resolve => setTimeout(resolve, 2000)); // wait for 2 sec

    const journeyName = `Journey_${eventDtStr}`;

    const journeyPayload = {
      key: journeyName,
      version: 1,
      name: journeyName,
      description: "Distributed Marketing Journey",
      workflowApiVersion: 1.0,
      createdDate: new Date().toISOString(),
      modifiedDate: new Date().toISOString(),
      iconUrl: "/events/images/icon_journeyBuilder-event-api-blue.svg",
      triggers: [
        {
          id: eventDefinitionId,  // Using the Event Definition ID we got from creation
          key: "TRIGGER",
          name: `New Journey - ${eventDtStr}`,
          description: "",
          type: "APIEvent",
          outcomes: [],
          arguments: {},
          configurationArguments: {},
          metaData: {
            eventDefinitionId: eventDefinitionId,
            eventDefinitionKey: eventKey,
            chainType: "None",
            configurationRequired: false,
            iconUrl: "/images/icon_journeyBuilder-event-api-blue.svg",
            title: "",
            entrySourceGroupConfigUrl: "jb:///data/entry/api-event/entrysourcegroupconfig.json",
            sourceInteractionId: "00000000-0000-0000-0000-000000000000"
          }
        }
      ],
      activities: [
        {
          key: "WAIT-1",
          name: "Wait 1 Day",
          type: "Wait",
          arguments: {
            duration: 1,
            unit: "days"
          }
        }
      ]
    };

    // Log the payload for debugging
    console.log('[Journey Payload]', JSON.stringify(journeyPayload, null, 2));

    try {
      const journeyResp = await axios.post(
        `https://${subdomain}.rest.marketingcloudapis.com/interaction/v1/interactions`,
        journeyPayload,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('[Journey Created]', journeyResp.data);
      journeyId = journeyResp.data.id;
    } catch (error) {
      console.log('[Journey Creation Error]', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        message: error.message
      });
      throw error;
    }

    return res.status(200).json({
      status: "OK",
      message: "Folder, Data Extension, Event, and Journey created successfully",
      folderName, // Show folderName instead of folderId
      deName,
      eventName, // Ensure eventName is included
      journeyName,
      journeyId
    });

  } catch (e) {
    console.error('❌ [DM DataExtension] Error:', e.response?.data || e.message);
    res.status(500).json({ status: 'ERROR', message: e.message });
  }
});

// Single Click Distributed Marketing Quick Send Setup
app.post('/createDMFullSetup', async (req, res) => {
  try {
    // 1. Get credentials and access token
    const creds = getMCCreds(req);
    const subdomain = creds.subdomain;
    const accessToken = getAccessTokenFromRequest(req);
    if (!accessToken || !subdomain) {
      return res.status(401).json({ status: 'ERROR', message: 'Missing Marketing Cloud credentials' });
    }

    // 2. Create Folder (if needed) and Data Extension
    // (Reuse your existing logic for folder/DE creation)
    // For demo, we'll use a timestamp for uniqueness
    const eventDtStr = new Date().toISOString().replace(/[:\-.]/g, '').slice(0, 14);
    const deName = `DM_MC_explorer_${eventDtStr}`;
    const folderId = Date.now().toString(); // Simulate folder ID

    // ... Insert your DE creation logic here ...
    // For demo, we'll just simulate a DE ObjectID
    const deObjectID = `${Math.random().toString(36).substring(2, 10)}-objectid`;

    // 3. Create Event Definition
    const eventKey = `dm_event_${eventDtStr}`;
    const eventName = `DM Event Definition - ${eventDtStr}`;
    // ... Insert your Event Definition creation logic here ...
    // For demo, we'll just simulate an eventDefinitionId
    const eventDefinitionId = `${Math.random().toString(36).substring(2, 10)}-eventid`;

    // 4. Create Journey
    const journeyName = `Journey_${eventDtStr}`;
    // ... Insert your Journey creation logic here ...

    // 5. Return the required details
    return res.json({
      status: 'OK',
      folderId,
      deName,
      eventName,
      eventDefinitionKey: eventKey,
      journeyName
    });
  } catch (e) {
    console.error('❌ [DM Quick Send Setup] Error:', e.message);
    res.status(500).json({ status: 'ERROR', message: e.message });
  }
});

// Preference Center Config API
app.post('/preference-center/configure', async (req, res) => {
  try {
    const config = req.body;
    const controllerDEName = 'PC_Controller';
    const logDEName = 'PC_Log';

    // Retrieve accessToken and subdomain
    const accessToken = getAccessTokenFromRequest(req);
    const subdomain = getSubdomainFromRequest(req);
    if (!accessToken || !subdomain) {
      return res.status(401).json({ status: 'ERROR', message: 'Missing Marketing Cloud credentials' });
    }

    // 1. Dynamically define DE fields based on config
    // 1. Define DE fields for Preference Center (no dynamic category/lead/contact/publication fields)
    const dynamicFields = [
      { Name: 'Header', FieldType: 'Text', MaxLength: 200, IsRequired: false, IsPrimaryKey: false },
      { Name: 'SubHeader', FieldType: 'Text', MaxLength: 200, IsRequired: false, IsPrimaryKey: false },
      { Name: 'Footer', FieldType: 'Text', MaxLength: 500, IsRequired: false, IsPrimaryKey: false },
      { Name: 'LogoUrl', FieldType: 'Text', MaxLength: 500, IsRequired: false, IsPrimaryKey: false },
      { Name: 'OptOutLabel', FieldType: 'Text', MaxLength: 200, IsRequired: false, IsPrimaryKey: false },
      { Name: 'IntegrationType', FieldType: 'Text', MaxLength: 50, IsRequired: true, IsPrimaryKey: true },
      { Name: 'CategoryLabels', FieldType: 'Text', MaxLength: 1000, IsRequired: false, IsPrimaryKey: false },
      { Name: 'ContactFields', FieldType: 'Text', MaxLength: 1000, IsRequired: false, IsPrimaryKey: false },
      { Name: 'LeadFields', FieldType: 'Text', MaxLength: 1000, IsRequired: false, IsPrimaryKey: false },
      { Name: 'Publications', FieldType: 'Text', MaxLength: 1000, IsRequired: false, IsPrimaryKey: false }
    ];

    const controllerDE = {
      Name: controllerDEName,
      CustomerKey: controllerDEName,
      Description: 'Stores config-driven field mapping for dynamic preference center',
      Fields: dynamicFields,
      Keys: [{ Name: 'IntegrationType', IsPrimaryKey: true }]
    };

    const logDE = {
      Name: logDEName,
      CustomerKey: logDEName,
      Description: 'Logs all preference updates and changes',
      Fields: [
        { Name: 'SubscriberKey', FieldType: 'Text', MaxLength: 100 },
        { Name: 'EmailAddress', FieldType: 'EmailAddress' },
        { Name: 'OldValues', FieldType: 'Text', MaxLength: 4000 },
        { Name: 'NewValues', FieldType: 'Text', MaxLength: 4000 },
        { Name: 'ChangeType', FieldType: 'Text', MaxLength: 100 },
        { Name: 'DateModified', FieldType: 'Date' }
      ],
      Keys: []
    };

    // Prepare row for controller DE (casing matches DE schema)
    //const categoryLabels = config.categories.map(cat => cat.label).join(' | ') + ' | ' + config.optOutLabel;
    const categoryLabels = config.categories.map(cat => cat.label).join(' | ');
    const contactFields = config.categories.map(cat => cat.fieldMapping.contact).join(' | ') + ' | hasOptedOutOfEmails';
    const leadFields = config.categories.map(cat => cat.fieldMapping.lead).join(' | ') + ' | hasOptedOutOfEmails';
    const publications = config.categories.map(cat => cat.publication?.name).filter(Boolean).join(' | ');

    const controllerRow = {
      CategoryLabels: categoryLabels,
      ContactFields: contactFields,
      LeadFields: leadFields,
      Publications: publications,
      Header: config.branding.header,
      SubHeader: config.branding.subHeader,
      Footer: config.branding.footer,
      LogoUrl: config.branding.logoUrl,
      OptOutLabel: config.optOutLabel,
      IntegrationType: config.integrationType
    };

    // Create DEs if they do not exist
    // PC_Controller logic: upsert if exists, else create and insert
    const controllerExists = await dataExtensionExists(controllerDEName, accessToken, subdomain);
    console.log(`[DEBUG] dataExtensionExists('${controllerDEName}') =`, controllerExists);
    if (controllerExists) {
      await upsertRowToDE(controllerDEName, controllerRow, accessToken, subdomain, ['IntegrationType']);
    } else {
      await createDataExtensionSOAP(controllerDEName, controllerDE, accessToken, subdomain);
      await insertRowToDE(controllerDEName, controllerRow, accessToken, subdomain);
    }

    // PC_Log: create if not exists
    const logExists = await dataExtensionExists(logDEName, accessToken, subdomain);
    console.log(`[DEBUG] dataExtensionExists('${logDEName}') =`, logExists);
    if (!logExists) {
      await createDataExtensionSOAP(logDEName, logDE, accessToken, subdomain);
    }

    // Create or get Publication Lists for each publication name using SOAP only
    const publicationNames = config.categories.map(cat => cat.publication?.name).filter(Boolean);
    const publicationListResults = [];
    for (const pubName of publicationNames) {
      try {
        await createPublicationListSOAP(
          pubName,
          accessToken,
          subdomain
        );
        publicationListResults.push({ name: pubName, status: 'created or already exists' });
      } catch (err) {
        publicationListResults.push({ name: pubName, status: 'error', error: err.message });
      }
    }
    console.log('[Publication List SOAP Results]', publicationListResults);

    console.log('[PC Controller DE]', controllerDEName, controllerDE);
    console.log('[PC Controller Row]', controllerRow);
    console.log('[PC Log DE]', logDEName, logDE);

    res.json({ status: 'OK', message: 'Preference Center configuration processed.', controllerDEName, logDEName });
  } catch (e) {
    console.error('[Preference Center Config Error]', e);
    res.status(500).json({ status: 'ERROR', message: e.message });
  }
});

// Helper to create a Data Extension in Marketing Cloud using SOAP
async function createDataExtensionSOAP(deName, deDef, accessToken, subdomain) {
  const fieldsXml = deDef.Fields.map(f => {
    // Only include MaxLength for Text and EmailAddress fields
    const maxLengthXml = (f.FieldType === 'Text' || f.FieldType === 'EmailAddress') ? `<MaxLength>${f.MaxLength || 100}</MaxLength>` : '';
    return `
      <Field>
        <Name>${f.Name}</Name>
        <FieldType>${f.FieldType}</FieldType>
        ${maxLengthXml}
        <IsRequired>${f.IsRequired ? 'true' : 'false'}</IsRequired>
        <IsPrimaryKey>${f.IsPrimaryKey ? 'true' : 'false'}</IsPrimaryKey>
      </Field>`;
  }).join('');

  const keysXml = deDef.Keys && deDef.Keys.length > 0
    ? `<Keys>${deDef.Keys.map(k => `
      <Key>
        <Name>${k.Name}</Name>
        <IsPrimaryKey>${k.IsPrimaryKey ? 'true' : 'false'}</IsPrimaryKey>
      </Key>`).join('')}
    </Keys>` : '';

  const soapEnvelope = `
    <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <soapenv:Header>
        <fueloauth>${accessToken}</fueloauth>
      </soapenv:Header>
      <soapenv:Body>
        <CreateRequest xmlns="http://exacttarget.com/wsdl/partnerAPI">
          <Objects xsi:type="DataExtension">
            <Name>${deName}</Name>
            <CustomerKey>${deName}</CustomerKey>
            <Description>${deDef.Description || ''}</Description>
            <Fields>
              ${fieldsXml}
            </Fields>
            ${keysXml}
          </Objects>
        </CreateRequest>
      </soapenv:Body>
    </soapenv:Envelope>
  `;

  // Debug: Log the final SOAP envelope
  console.log('[SOAP Envelope]', soapEnvelope);

  const url = `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`;
  const resp = await axios.post(url, soapEnvelope, {
    headers: { 'Content-Type': 'text/xml', SOAPAction: 'Create' }
  });

  if (!resp.data.includes('<OverallStatus>OK</OverallStatus>')) {
    if (resp.data.includes('DataExtension with CustomerKey already exists') || resp.data.includes('Updating an existing Data Extension definition is not allowed')) {
      console.log(`[Info] DE '${deName}' already exists or cannot be updated. Skipping create.`);
      return true;
    }
    throw new Error('Failed to create DE: ' + deName + '\nResponse: ' + resp.data);
  }

  return true;
}

// Helper to insert a row into a Data Extension using REST API
async function insertRowToDE(deName, rowData, accessToken, subdomain) {
  const url = `https://${subdomain}.rest.marketingcloudapis.com/hub/v1/dataevents/key:${deName}/rowset`;

  const payload = [
    {
      keys: { IntegrationType: rowData.IntegrationType },
      values: rowData
    }
  ];

  const resp = await axios.post(url, payload, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (![200, 201, 202].includes(resp.status)) {
    console.error('[Insert Row Error]', resp.status, resp.data);
    throw new Error('Failed to insert row into DE: ' + deName);
  }

  console.log(`[✔] Inserted config row into '${deName}'`);
}

// Helper to upsert a row into a Data Extension using REST API
async function upsertRowToDE(deName, rowData, accessToken, subdomain, primaryKeys = ['IntegrationType']) {
  const url = `https://${subdomain}.rest.marketingcloudapis.com/hub/v1/dataevents/key:${deName}/rowset`;
  const keys = {};
  primaryKeys.forEach(k => { keys[k] = rowData[k]; });
  const payload = [
    {
      keys,
      values: rowData
    }
  ];
  const resp = await axios.post(url, payload, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (![200, 201, 202].includes(resp.status)) {
    console.error('[Upsert Row Error]', resp.status, resp.data);
    throw new Error('Failed to upsert row into DE: ' + deName);
  }
  console.log(`[✔] Upserted config row into '${deName}'`);
}

// Helper to check if a Data Extension exists using REST API
async function dataExtensionExists(deName, accessToken, subdomain) {
  const url = `https://${subdomain}.rest.marketingcloudapis.com/hub/v1/dataevents/key:${deName}`;
  try {
    const resp = await axios.get(url, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      }
    });
    // If we get a 200, the DE exists
    return resp.status === 200;
  } catch (err) {
    if (err.response && err.response.status === 404) {
      return false; // DE does not exist
    }
    // Other errors should be thrown
    throw err;
  }
}

// Helper: Get Publication List ID by name
async function getPublicationListIdByName(listName, accessToken, subdomain) {
  const url = `https://${subdomain}.rest.marketingcloudapis.com/contacts/v1/lists?$filter=name eq '${listName}'`;
  try {
    const resp = await axios.get(url, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      }
    });
    const matchingList = resp.data?.items?.find(item => item.name === listName);
    return matchingList ? matchingList.id : null;
  } catch (err) {
    if (err.response && err.response.status === 404) {
      return null; // List does not exist, so return null to trigger creation
    }
    throw err; // Other errors should still be thrown
  }
}

// Helper: Create Publication List
async function createPublicationList(listName, description, accessToken, subdomain) {
  const url = `https://${subdomain}.rest.marketingcloudapis.com/contacts/v1/lists`;
  const payload = {
    name: listName,
    description: description,
    type: "publication",
    status: "active"
  };
  const resp = await axios.post(url, payload, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (![200, 201, 202].includes(resp.status)) {
    console.error('[Publication List Error]', resp.status, resp.data);
    throw new Error('Failed to create publication list: ' + listName);
  }
  console.log(`[✔] Publication List '${listName}' created successfully.`);
  return resp.data.id;
}

// Helper: Create Publication List using SOAP
async function createPublicationListSOAP(listName, accessToken, subdomain) {
  // Debug: Log input parameters
  console.log('[DEBUG] createPublicationListSOAP called with:', { listName, subdomain });
  const soapEnvelope = `
    <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <soapenv:Header>
        <fueloauth>${accessToken}</fueloauth>
      </soapenv:Header>
      <soapenv:Body>
        <CreateRequest xmlns="http://exacttarget.com/wsdl/partnerAPI">
          <Objects xsi:type="List">
            <ListName>${listName}</ListName>
            <CustomerKey>${listName}</CustomerKey>
            <Type>Publication</Type>
            <Description>${listName}</Description>
            <Sendable>true</Sendable>
            <SendableDataExtensionField>
            <Name>Email Address</Name>
            </SendableDataExtensionField>
            <SendableSubscriberField>
            <Name>Email Address</Name>
            </SendableSubscriberField>
          </Objects>
        </CreateRequest>
      </soapenv:Body>
    </soapenv:Envelope>
  `;
  // Debug: Log the SOAP envelope being sent
  console.log('[DEBUG] Publication List SOAP Envelope:', soapEnvelope);
  const url = `https://${subdomain}.soap.marketingcloudapis.com/Service.asmx`;
  const resp = await axios.post(url, soapEnvelope, {
    headers: { 'Content-Type': 'text/xml', SOAPAction: 'Create' }
  });
  // Debug: Log the raw SOAP response
  console.log('[DEBUG] Publication List SOAP Response:', resp.data);
  if (!resp.data.includes('<OverallStatus>OK</OverallStatus>')) {
    if (resp.data.includes('already exists')) {
      console.log(`[Info] Publication List '${listName}' already exists.`);
      return true;
    }
    throw new Error('Failed to create publication list: ' + listName + '\nResponse: ' + resp.data);
  }
  console.log(`[✔] Publication List '${listName}' created successfully.`);
  return true;
}

// Retrieve Send (Job) details by Job ID, EmailName, Subject, or SentDate range
app.get('/api/email-archive/send', async (req, res) => {
  try {
    const { jobId, emailName, subject, sentDateFrom, sentDateTo } = req.query;
    const subdomain = getSubdomainFromRequest(req);
    const accessToken = getAccessTokenFromRequest(req);
    if (!subdomain || !accessToken) return res.status(401).json({ error: 'Missing subdomain or access token' });

    // Build filter (null means fetch all)
    let filter = null;
    if (jobId) {
      filter = { property: 'ID', operator: 'equals', value: jobId };
    } else if (emailName) {
      filter = { property: 'EmailName', operator: 'equals', value: emailName };
    } else if (subject) {
      filter = { property: 'Subject', operator: 'equals', value: subject };
    } else if (sentDateFrom && sentDateTo) {
      filter = {
        left: { property: 'SentDate', operator: 'greaterThanOrEqual', value: sentDateFrom },
        logicalOperator: 'AND',
        right: { property: 'SentDate', operator: 'lessThanOrEqual', value: sentDateTo }
      };
    } // else: filter remains null (fetch all)

    const xml = await require('./retrieveSend').retrieveSendWithFilter(subdomain, accessToken, filter);
    // Parse XML to JSON
    const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false });
    // Extract results from SOAP response
    let results = [];
    try {
      const retrieveResponse = parsed['soap:Envelope']['soap:Body']['RetrieveResponseMsg']['Results'];
      if (Array.isArray(retrieveResponse)) {
        results = retrieveResponse;
      } else if (retrieveResponse) {
        results = [retrieveResponse];
      }
    } catch (e) {
      results = [];
    }
    // Map to only relevant fields for frontend
    const mapped = results.map(r => ({
      SentDate: r.SentDate || '',
      EmailName: r.EmailName || '',
      Subject: r.Subject || '',
      ID: r.ID || '',
      SubscriberKey: r.SubscriberKey || '',
      MID: r['Client']?.ID || r['Client.ID'] || '',
      FromName: r.FromName || '',
      FromAddress: r.FromAddress || '',
      NumberSent: r.NumberSent || '',
    }));
    res.json({ results: mapped });
  } catch (err) {
    console.error('❌ Error retrieving send:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Register the SentEvent endpoint
require('./emailArchiveSentEventsEndpoint')(app);

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// Serve React frontend (must be last)
app.use(express.static(path.join(__dirname, '../mc-explorer-client/build')));
app.get(/(.*)/, (req, res) => {
  res.sendFile(path.join(__dirname, '../mc-explorer-client/build/index.html'));
});
