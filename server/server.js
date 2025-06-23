// server.js (Full with working auth redirect)
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

const PORT = process.env.PORT || 3001;
let dynamicCreds = {
  subdomain: '',
  clientId: '',
  clientSecret: '',
  accountId: ''
};

console.log("✅ Env loaded:", {
  CLIENT_ID: process.env.CLIENT_ID,
  CLIENT_SECRET: process.env.CLIENT_SECRET,
  AUTH_DOMAIN: process.env.AUTH_DOMAIN,
  REDIRECT_URI: process.env.REDIRECT_URI
});

app.post('/save-credentials', (req, res) => {
  const { subdomain, clientId, clientSecret, accountId } = req.body;
  dynamicCreds = { subdomain, clientId, clientSecret, accountId };

  const redirectUri = `${process.env.BASE_URL}/auth/callback`;
  const loginUrl = `https://${subdomain}.auth.marketingcloudapis.com/v2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`;
  console.log('🔐 Generated Login URL:', loginUrl);
  res.json({ redirectUrl: loginUrl });
});

app.get('/auth/login', (req, res) => {
  const loginUrl = `https://${process.env.AUTH_DOMAIN}/v2/authorize?client_id=${process.env.CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&response_type=code`;
  console.log('🔐 Redirecting to login URL:', loginUrl);
  res.redirect(loginUrl);
});

app.get('/auth/callback', (req, res) => {
  // Serve the React app for SPA routing; do NOT handle code exchange here
  res.sendFile(path.join(__dirname, '../mc-explorer-client/build/index.html'));
});

app.post('/auth/callback', async (req, res) => {
  const code = req.body.code;
  console.log('🔔 POST /auth/callback called with code:', code);
  if (!code) {
    console.error('❌ No code provided in POST /auth/callback');
    return res.status(400).json({ success: false, error: 'Missing authorization code' });
  }
  try {
    console.log('🔗 Requesting token from:', `https://${process.env.AUTH_DOMAIN}/v2/token`);
    const tokenResponse = await axios.post(
      `https://${process.env.AUTH_DOMAIN}/v2/token`,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        redirect_uri: process.env.REDIRECT_URI
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const accessToken = tokenResponse.data.access_token;
    const refreshToken = tokenResponse.data.refresh_token;
    // Extract subdomain from AUTH_DOMAIN
    const match = process.env.AUTH_DOMAIN.match(/^([^.]+)\./);
    const subdomain = match ? match[1] : null;
    console.log('✅ Token response:', tokenResponse.data);
    res.json({ success: true, accessToken, refreshToken, subdomain });
  } catch (err) {
    console.error('❌ OAuth Token Exchange Error (POST):', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

function getAccessTokenFromRequest(req) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  return null;
}
function getSubdomainFromRequest(req) {
  return req.headers['x-mc-subdomain'] || null;
}

// Data Extension Search
app.get('/search/de', async (req, res) => {
  const accessToken = getAccessTokenFromRequest(req);
  const subdomain = getSubdomainFromRequest(req);
  if (!accessToken || !subdomain) {
    return res.status(401).json([]);
  }
  try {
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
        const simplified = resultArray.map(de => ({
          name: de.Name || 'N/A',
          key: de.CustomerKey || 'N/A',
          createdDate: de.CreatedDate || 'N/A',
          categoryId: de.CategoryID ? String(de.CategoryID) : null
        }));
        res.json(simplified);
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

// Automation Search
app.get('/search/automation', async (req, res) => {
  const accessToken = getAccessTokenFromRequest(req);
  const subdomain = getSubdomainFromRequest(req);
  if (!accessToken || !subdomain) {
    return res.status(401).json([]);
  }
  try {
    const response = await axios.get(
      `https://${subdomain}.rest.marketingcloudapis.com/automation/v1/automations`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );
    const automations = response.data.items || [];
    const simplified = automations.map(a => ({
      name: a.name || 'N/A',
      key: a.key || a.customerKey || 'N/A',
      status: a.status || 'N/A',
      createdDate: a.createdDate || 'N/A',
      lastRunTime: a.lastRunTime || 'N/A',
      categoryId: a.categoryId || 'N/A',
    }));
    res.json(simplified);
  } catch (err) {
    console.error('❌ Automation REST error:', err.response?.data || err);
    res.status(500).json({ error: 'Failed to fetch Automations via REST' });
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
      const dataFilters = normalized.map(item => ({
        name: item.Name || 'N/A',
        key: item.CustomerKey || 'N/A',
        description: item.Description || 'N/A',
        createdDate: item.CreatedDate || 'N/A',
        folderId: item.CategoryID || 'N/A',
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
    const response = await axios.get(
      `https://${subdomain}.rest.marketingcloudapis.com/interaction/v1/interactions`,
      {
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );
    const journeys = response.data.items || [];
    const simplified = journeys.map(j => ({
      name: j.name || 'N/A',
      key: j.key || 'N/A',
      status: j.status || 'N/A',
      lastPublishedDate: j.lastPublishedDate || 'N/A',
      versionNumber: j.versionNumber || 'N/A',
      categoryId: j.categoryId || null,
      createdDate: j.createdDate || 'Not Available'
    }));
    res.json(simplified);
  } catch (err) {
    console.error('❌ Journey fetch error:', err.response?.data || err);
    res.status(500).json({ error: 'Failed to fetch journeys' });
  }
});

// Serve React frontend
app.use(express.static(path.join(__dirname, '../mc-explorer-client/build')));
app.get(/(.*)/, (req, res) => {
  res.sendFile(path.join(__dirname, '../mc-explorer-client/build/index.html'));
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
