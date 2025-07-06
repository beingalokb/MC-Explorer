import React, { useState, useEffect } from 'react';
import './App.css';
import PreferenceCenterProjectForm from './PreferenceCenterProjectForm';
import PreferenceCenterNoCoreForm from './PreferenceCenterNoCoreForm';

const baseURL = process.env.REACT_APP_BASE_URL;

export default function MainApp() {
  const [loading, setLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [activeTab, setActiveTab] = useState('de');
  const [dataExtensions, setDataExtensions] = useState([]);
  const [automations, setAutomations] = useState([]);
  const [dataFilters, setDataFilters] = useState([]);
  const [journeys, setJourneys] = useState([]);
  const [folderMap, setFolderMap] = useState({});
  const [searchTerm, setSearchTerm] = useState('');
  const [sortConfig, setSortConfig] = useState({ key: null, direction: 'asc' });
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(10);
  const [pendingFetches, setPendingFetches] = useState(0);
  const [deDetailModal, setDeDetailModal] = useState({ open: false, loading: false, error: null, details: null, name: null });
  const [automationDetailModal, setAutomationDetailModal] = useState({ open: false, loading: false, error: null, details: null, name: null });
  const [emailSendDefinitions, setEmailSendDefinitions] = useState([]);

  const [senderProfiles, setSenderProfiles] = useState([]);
  const [sendClassifications, setSendClassifications] = useState([]);
  const [deliveryProfiles, setDeliveryProfiles] = useState([]);
  const [sendClassModal, setSendClassModal] = useState({ open: false, loading: false, error: null, details: null, name: null });
  const [senderProfileModal, setSenderProfileModal] = useState({ open: false, loading: false, error: null, details: null, name: null });
  const [updateSenderProfileModal, setUpdateSenderProfileModal] = useState({ open: false, loading: false, error: null, customerKey: null, selectedKey: '', success: false });
  const [configJson, setConfigJson] = useState('');
  const [parsedRelationships, setParsedRelationships] = useState([]);
  const [configError, setConfigError] = useState('');
  const [resolvedEmailSendDefs, setResolvedEmailSendDefs] = useState([]);
  const [resolvedError, setResolvedError] = useState('');

  // Add new state for edit modal
  const [editESDModal, setEditESDModal] = useState({ open: false, loading: false, error: null, esd: null, sendClassification: '', senderProfile: '', deliveryProfile: '' });

  // State for mass selection
  const [selectedESDKeys, setSelectedESDKeys] = useState([]);
  const allSelected = resolvedEmailSendDefs.length > 0 && selectedESDKeys.length === resolvedEmailSendDefs.length;

  // State for mass edit modal
  const [massEditModal, setMassEditModal] = useState({ open: false, sendClassification: '', senderProfile: '', deliveryProfile: '', loading: false, error: null });

  // Publications state
  const [publications, setPublications] = useState([]);

  // Add new top-level tab for Distributed Marketing
  const [dmStep, setDMStep] = useState(1);
  const [dmDEPath, setDMDEPath] = useState('');
  const [dmJourneyPath, setDMJourneyPath] = useState('');
  const [dmStatus, setDMStatus] = useState('');

  // Add new state for DM Quick Send
  const [qsStatus, setQSStatus] = useState("");
  const [qsDetails, setQSDetails] = useState(null);
  const [qsLoading, setQSLoading] = useState(false);

  // Helper to get human-readable name for related fields
  function getProfileName(profiles, key) {
    if (!key) return '';
    const found = profiles.find(p => p.CustomerKey === key);
    return found ? found.Name : key;
  }
  function getProfileDesc(profiles, key) {
    if (!key) return '';
    const found = profiles.find(p => p.CustomerKey === key);
    return found ? found.Description : '';
  }

  // Parent navigation state
  const [parentNav, setParentNav] = useState('search'); // 'search' or 'preference'
  const [previewResult, setPreviewResult] = useState(null);
  const [guidedPrefOption, setGuidedPrefOption] = useState('');

  const handleLogout = async () => {
    // Clear local/session storage
    localStorage.removeItem('isAuthenticated');
    localStorage.removeItem('mc_subdomain');
    localStorage.removeItem('mc_clientId');
    localStorage.removeItem('mc_clientSecret');
    localStorage.removeItem('mc_accountId');
    sessionStorage.clear();
    // Call backend to clear session
    try {
      await fetch('/logout', { method: 'POST', credentials: 'include' });
    } catch (e) {
      // Ignore errors
    }
    // Redirect to setup
    window.location.href = '/setup';
  };

 useEffect(() => {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('auth') === '1') {
    localStorage.setItem('isAuthenticated', 'true');
    urlParams.delete('auth');
    if (urlParams.get('reload') === '1') {
      urlParams.delete('reload');
      const cleanUrl = `${window.location.pathname}?${urlParams.toString()}`;
      window.location.replace(cleanUrl); // force a reload
    } else {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }
  const authStatus = localStorage.getItem('isAuthenticated') === 'true';
  setIsAuthenticated(authStatus);
  // Don't setLoading(false) here!
}, []);

  useEffect(() => {
    if (!isAuthenticated) return;

    fetch(`${baseURL}/business-units`, { credentials: 'include' })
  .then(res => {
    console.log("🔁 Session check /business-units response:", res.status);
    if (res.status === 401) {
      console.warn('⚠️ Session expired or unauthorized. Redirecting to login...');
      localStorage.removeItem('isAuthenticated');
      window.location.href = '/login';
    }
      })
      .catch(err => {
        console.error('🚨 Error while checking session:', err);
        localStorage.removeItem('isAuthenticated');
        window.location.href = '/login';
      });
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) return;

    const accessToken = localStorage.getItem('accessToken');
    const subdomain = localStorage.getItem('subdomain');
    if (!accessToken || !subdomain) {
      console.warn('⚠️ No access token or subdomain found. Redirecting to login...');
      localStorage.removeItem('isAuthenticated');
      window.location.href = '/login';
      return;
    }

    setLoading(true);
    setPendingFetches(6); // 6 fetches: DE, Automation, DataFilter, Journey, Folders, Publications

    const fetchWithLogging = async (path, setter, label) => {
      try {
        const res = await fetch(`${baseURL}${path}`, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'x-mc-subdomain': subdomain
          }
        });
        if (res.status === 401) {
          console.warn(`🚫 ${label} fetch unauthorized`);
          setter([]);
        } else {
          const json = await res.json();
          console.log(`✅ ${label} fetched`, json);
          setter(Array.isArray(json) ? json : []);
        }
      } catch (e) {
        console.error(`❌ Failed to fetch ${label}`, e);
        setter([]);
      } finally {
        setPendingFetches(prev => prev - 1);
      }
    };

    fetchWithLogging('/search/de', setDataExtensions, 'Data Extensions');
    fetchWithLogging('/search/automation', setAutomations, 'Automations');
    fetchWithLogging('/search/datafilters', setDataFilters, 'Data Filters');
    fetchWithLogging('/search/journeys', setJourneys, 'Journeys');
    fetchWithLogging('/folders', folders => {
      const map = {};
      (folders || []).forEach(f => map[f.ID] = f);
      setFolderMap(map);
    }, 'Folders');
    fetchWithLogging('/search/publication', setPublications, 'Publications');
  }, [isAuthenticated]);

  // Fetch data for the selected tab when activeTab changes
  useEffect(() => {
    if (!isAuthenticated) return;
    console.log('Current activeTab:', activeTab); // DEBUG
    const accessToken = localStorage.getItem('accessToken');
    const subdomain = localStorage.getItem('subdomain');
    if (!accessToken || !subdomain) return;
    setLoading(true);
    setPendingFetches(1);
    const fetchWithLogging = async (path, setter, label) => {
      try {
        console.log('Fetching', label, 'from', path); // DEBUG
        const res = await fetch(`${baseURL}${path}`, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'x-mc-subdomain': subdomain
          }
        });
        if (res.status === 401) {
          setter([]);
        } else {
          const json = await res.json();
          setter(Array.isArray(json) ? json : []);
        }
      } catch (e) {
        setter([]);
      } finally {
        setPendingFetches(prev => prev - 1);
      }
    };
    if (activeTab === 'de') fetchWithLogging('/search/de', setDataExtensions, 'Data Extensions');
    if (activeTab === 'automation') fetchWithLogging('/search/automation', setAutomations, 'Automations');
    if (activeTab === 'datafilter') fetchWithLogging('/search/datafilters', setDataFilters, 'Data Filters');
    if (activeTab === 'journey') fetchWithLogging('/search/journeys', setJourneys, 'Journeys');
    if (activeTab === 'emailsenddefinition') {
      console.log('Fetching EmailSendDefinition'); // DEBUG
      fetchWithLogging('/search/emailsenddefinition', setEmailSendDefinitions, 'EmailSendDefinitions');
      // Fetch related profiles/classifications
      fetchWithLogging('/search/senderprofile', setSenderProfiles, 'SenderProfiles');
      fetchWithLogging('/search/sendclassification', setSendClassifications, 'SendClassifications');
      fetchWithLogging('/search/deliveryprofile', setDeliveryProfiles, 'DeliveryProfiles');
    }
    if (activeTab === 'publication') fetchWithLogging('/search/publication', setPublications, 'Publications');
  }, [activeTab, isAuthenticated]);

  useEffect(() => {
    if (pendingFetches === 0 && isAuthenticated) setLoading(false);
  }, [pendingFetches, isAuthenticated]);

  const buildFolderPath = (id) => {
    if (!id || !folderMap[id]) return 'N/A';
    const path = [];
    let current = folderMap[id];
    while (current) {
      path.unshift(current.Name);
      current = folderMap[current.ParentFolder?.ID];
    }
    return '/' + path.join(' / ');
  };

  const sortData = (data) => {
    if (!sortConfig.key) return data;
    return [...data].sort((a, b) => {
      let aVal, bVal;
      if (sortConfig.key === 'path') {
        aVal = (a.path || '').toString().toLowerCase();
        bVal = (b.path || '').toString().toLowerCase();
      } else {
        aVal = a[sortConfig.key]?.toString().toLowerCase() || '';
        bVal = b[sortConfig.key]?.toString().toLowerCase() || '';
      }
      return sortConfig.direction === 'asc'
        ? aVal.localeCompare(bVal)
        : bVal.localeCompare(aVal);
    });
  };

  const requestSort = (key) => {
    const direction = sortConfig.key === key && sortConfig.direction === 'asc' ? 'desc' : 'asc';
    setSortConfig({ key, direction });
  };

  // Returns filtered and sorted data across all tabs if searchTerm is not empty, otherwise just the active tab
  const getFilteredData = () => {
    const term = searchTerm.toLowerCase();
    const matches = (item) =>
      Object.values(item || {}).some(val =>
        (val || '').toString().toLowerCase().includes(term)
      );

    let filtered = [];
    if (term) {
      // Search across all modules, including EmailSendDefinition
      filtered = [
        ...(dataExtensions || []).map(item => ({ ...item, _type: 'Data Extension' })),
        ...(automations || []).map(item => ({ ...item, _type: 'Automation' })),
        ...(dataFilters || []).map(item => ({ ...item, _type: 'Data Filter' })),
        ...(journeys || []).map(item => ({ ...item, _type: 'Journey' })),
        ...(resolvedEmailSendDefs || []).map(item => ({ ...item, _type: 'EmailSendDefinition' })),
        ...(publications || []).map(item => ({ ...item, _type: 'Publication' }))
      ].filter(matches);
    } else {
      // Only show active tab
      if (activeTab === 'de') filtered = (dataExtensions || []).map(item => ({ ...item, _type: 'Data Extension' }));
      else if (activeTab === 'automation') filtered = (automations || []).map(item => ({ ...item, _type: 'Automation' }));
      else if (activeTab === 'datafilter') filtered = (dataFilters || []).map(item => ({ ...item, _type: 'Data Filter' }));
      else if (activeTab === 'journey') filtered = (journeys || []).map(item => ({ ...item, _type: 'Journey' }));
      else if (activeTab === 'emailsenddefinition') filtered = (resolvedEmailSendDefs || []).map(item => ({ ...item, _type: 'EmailSendDefinition' }));
      else if (activeTab === 'publication') filtered = (publications || []).map(item => ({ ...item, _type: 'Publication' }));
    }
    return sortData(filtered);
  };

  const paginatedData = () => {
    const filtered = getFilteredData();
    const startIndex = (currentPage - 1) * itemsPerPage;
    return filtered.slice(startIndex, startIndex + itemsPerPage);
  };

  const totalPages = Math.ceil(getFilteredData().length / itemsPerPage);

  // CSV download functionality
  const downloadCSV = () => {
    const filtered = getFilteredData();
    const headers = ['Name', 'Created', 'Path'];
    const rows = filtered.map(item => [
      '"' + (item.name || '').replace(/"/g, '""') + '"',
      '"' + (item.createdDate || 'N/A').replace(/"/g, '""') + '"',
      '"' + (item.path || 'N/A').replace(/"/g, '""') + '"'
    ]);
    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeTab}_export.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Helper to group by created date
  const getDateGroups = (items) => {
    const now = new Date();
    const daysAgo = (d) => {
      if (!d) return Infinity;
      const dt = new Date(d);
      return (now - dt) / (1000 * 60 * 60 * 24);
    };
    let last7 = 0, last30 = 0, last180 = 0, last365 = 0;
    items.forEach(item => {
      const days = daysAgo(item.createdDate);
      if (days <= 7) last7++;
      if (days <= 30) last30++;
      if (days <= 180) last180++;
      if (days <= 365) last365++;
    });
    return { last7, last30, last180, last365 };
  };

  const deGroups = getDateGroups(dataExtensions);
  const autoGroups = getDateGroups(automations);
  const dfGroups = getDateGroups(dataFilters);
  const journeyGroups = getDateGroups(journeys);
  const pubGroups = getDateGroups(publications);

  // Fetch DE details on demand
  const fetchDeDetails = async (name) => {
    setDeDetailModal({ open: true, loading: true, error: null, details: null, name });
    try {
      const accessToken = localStorage.getItem('accessToken');
      const subdomain = localStorage.getItem('subdomain');
      const res = await fetch(`${baseURL}/de/details?name=${encodeURIComponent(name)}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'x-mc-subdomain': subdomain
        }
      });
      if (!res.ok) throw new Error('Failed to fetch details');
      const details = await res.json();
      setDeDetailModal({ open: true, loading: false, error: null, details, name });
    } catch (e) {
      setDeDetailModal({ open: true, loading: false, error: e.message, details: null, name });
    }
  };

  // Fetch Automation details on demand
  const fetchAutomationDetails = async (name, id) => {
    setAutomationDetailModal({ open: true, loading: true, error: null, details: null, name });
    try {
      const accessToken = localStorage.getItem('accessToken');
      const subdomain = localStorage.getItem('subdomain');
      const res = await fetch(`${baseURL}/automation/details?programId=${encodeURIComponent(id)}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'x-mc-subdomain': subdomain
        }
      });
      if (!res.ok) throw new Error('Failed to fetch details');
      const details = await res.json();
      setAutomationDetailModal({ open: true, loading: false, error: null, details, name });
    } catch (e) {
      setAutomationDetailModal({ open: true, loading: false, error: e.message, details: null, name });
    }
  };

  // Handler for Preference Center Builder form submission
  const handlePreferenceCenterSubmit = async (config) => {
    try {
      setPreviewResult({ loading: true });
      const accessToken = localStorage.getItem('accessToken');
      const subdomain = localStorage.getItem('subdomain');
      const res = await fetch('/preference-center/project', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'x-mc-subdomain': subdomain
        },
        body: JSON.stringify(config)
      });
      const data = await res.json();
      setPreviewResult({ loading: false, data });
      console.log('✅ Preference Center generated:', data);
    } catch (e) {
      setPreviewResult({ loading: false, error: e.message });
      console.error('❌ Preference Center generation failed:', e);
    }
  };

  // Handler to fetch SendClassification details by name
  const fetchSendClassDetails = async (name) => {
    setSendClassModal({ open: true, loading: true, error: null, details: null, name });
    try {
      const accessToken = localStorage.getItem('accessToken');
      const subdomain = localStorage.getItem('subdomain');
      const res = await fetch(`${baseURL}/search/sendclassification?name=${encodeURIComponent(name)}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'x-mc-subdomain': subdomain
        }
      });
      if (!res.ok) throw new Error('Failed to fetch details');
      const details = await res.json();
      setSendClassModal({ open: true, loading: false, error: null, details, name });
    } catch (e) {
      setSendClassModal({ open: true, loading: false, error: e.message, details: null, name });
    }
  };

  // Handler to fetch SenderProfile details by name
  const fetchSenderProfileDetails = async (name) => {
    setSenderProfileModal({ open: true, loading: true, error: null, details: null, name });
    try {
      const accessToken = localStorage.getItem('accessToken');
      const subdomain = localStorage.getItem('subdomain');
      const res = await fetch(`${baseURL}/search/senderprofile?name=${encodeURIComponent(name)}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'x-mc-subdomain': subdomain
        }
      });
      if (!res.ok) throw new Error('Failed to fetch details');
      const details = await res.json();
      setSenderProfileModal({ open: true, loading: false, error: null, details, name });
    } catch (e) {
      setSenderProfileModal({ open: true, loading: false, error: e.message, details: null, name });
    }
  };

  // Handler to open update modal
  const openUpdateSenderProfileModal = (customerKey) => {
    setUpdateSenderProfileModal({ open: true, loading: false, error: null, customerKey, selectedKey: '', success: false });
  };

  // Handler to update sender profile
  const handleUpdateSenderProfile = async () => {
    setUpdateSenderProfileModal(modal => ({ ...modal, loading: true, error: null, success: false }));
    try {
      const accessToken = localStorage.getItem('accessToken');
      const subdomain = localStorage.getItem('subdomain');
      const res = await fetch(`${baseURL}/update/emailsenddefinition-senderprofile`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'x-mc-subdomain': subdomain
        },
        body: JSON.stringify({
          customerKey: updateSenderProfileModal.customerKey,
          newSenderProfileKey: updateSenderProfileModal.selectedKey
        })
      });
      if (!res.ok) throw new Error('Update failed');
      setUpdateSenderProfileModal(modal => ({ ...modal, loading: false, error: null, success: true }));
      // Refresh EmailSendDefinition data after update
      setPendingFetches(prev => prev + 1);
      fetch(`${baseURL}/search/emailsenddefinition`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`,
          'x-mc-subdomain': localStorage.getItem('subdomain')
        }
      })
        .then(r => r.json())
        .then(data => setEmailSendDefinitions(Array.isArray(data) ? data : []))
        .finally(() => setPendingFetches(prev => prev - 1));
    } catch (e) {
      setUpdateSenderProfileModal(modal => ({ ...modal, loading: false, error: e.message, success: false }));
    }
  };

  // Handler to open edit modal
  function openEditESDModal(esd) {
    setEditESDModal({
      open: true,
      loading: false,
      error: null,
      esd,
      sendClassification: esd.SendClassification.CustomerKey,
      senderProfile: esd.SenderProfile.CustomerKey,
      deliveryProfile: esd.DeliveryProfile.CustomerKey
    });
  }

  // Handler to close edit modal
  function closeEditESDModal() {
    setEditESDModal({ open: false, loading: false, error: null, esd: null, sendClassification: '', senderProfile: '', deliveryProfile: '' });
  }

  // Handler for dropdown changes
  function handleEditESDChange(field, value) {
    setEditESDModal(prev => ({ ...prev, [field]: value }));
  }

  // Helper to get CustomerKey from name or key
  function getCustomerKey(profiles, value) {
    if (!value) return '';
    // If value matches a CustomerKey, return it
    if (profiles.some(p => p.CustomerKey === value)) return value;
    // Otherwise, try to find by Name
    const found = profiles.find(p => p.Name === value);
    return found ? found.CustomerKey : value;
  }

  // Handler to submit update
  async function submitEditESDModal() {
    setEditESDModal(prev => ({ ...prev, loading: true, error: null }));
    try {
      const accessToken = localStorage.getItem('accessToken');
      const subdomain = localStorage.getItem('subdomain');
      // Always use CustomerKey for these fields
      const sendClassificationKey = getCustomerKey(sendClassifications, editESDModal.sendClassification);
      const senderProfileKey = getCustomerKey(senderProfiles, editESDModal.senderProfile);
      const deliveryProfileKey = getCustomerKey(deliveryProfiles, editESDModal.deliveryProfile);
      const res = await fetch(`${baseURL}/update/emailsenddefinition`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'x-mc-subdomain': subdomain
        },
        body: JSON.stringify({
          CustomerKey: editESDModal.esd.CustomerKey,
          SendClassification: sendClassificationKey,
          SenderProfile: senderProfileKey,
          DeliveryProfile: deliveryProfileKey
        })
      });
      const data = await res.json();
      if (data.status === 'OK') {
        setEditESDModal(prev => ({ ...prev, loading: false, open: false }));
        // Show success toast/snackbar
        alert('✅ Updated successfully');
        // Refresh table with resolved relationships
        await refreshResolvedEmailSendDefs();
      } else {
        setEditESDModal(prev => ({ ...prev, loading: false, error: data.message || 'Update failed' }));
        alert('❌ Update failed: ' + (data.message || 'Unknown error'));
      }
    } catch (err) {
      setEditESDModal(prev => ({ ...prev, loading: false, error: err.message }));
      alert('❌ Update failed: ' + err.message);
    }
  }

  // Handler for config upload
  const handleConfigFileChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      setConfigJson(evt.target.result);
    };
    reader.readAsText(file);
  };

  // Handler for config submit
  const handleConfigSubmit = async () => {
    setConfigError('');
    setParsedRelationships([]);
    let json;
    try {
      json = JSON.parse(configJson);
    } catch (e) {
      setConfigError('Invalid JSON');
      return;
    }
    try {
      const res = await fetch(`${baseURL}/parse/emailsenddefinition-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(json)
      });
      if (!res.ok) throw new Error('Failed to parse config');
      const data = await res.json();
      setParsedRelationships(data);
    } catch (e) {
      setConfigError(e.message);
    }
  };

  // Helper to refresh resolved EmailSendDefinitions
  async function refreshResolvedEmailSendDefs() {
    const accessToken = localStorage.getItem('accessToken');
    const subdomain = localStorage.getItem('subdomain');
    if (!accessToken || !subdomain) return;
    try {
      const res = await fetch(`${baseURL}/resolved/emailsenddefinition-relationships`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'x-mc-subdomain': subdomain
        }
      });
      if (!res.ok) throw new Error('Failed to fetch resolved relationships');
      const data = await res.json();
      setResolvedEmailSendDefs(Array.isArray(data) ? data : []);
    } catch (e) {
      setResolvedError(e.toString());
    }
  }

  useEffect(() => {
    if (activeTab === 'emailsenddefinition' && isAuthenticated) {
      setResolvedError('');
      setResolvedEmailSendDefs([]);
      refreshResolvedEmailSendDefs();
    }
  }, [activeTab, isAuthenticated]);

  // State for mass selection
  // (already declared at the top)

  // Handlers for select all and individual selection
  function toggleSelectAllESD() {
    if (allSelected) setSelectedESDKeys([]);
    else setSelectedESDKeys(resolvedEmailSendDefs.map(r => r.CustomerKey));
  }
  function toggleSelectESD(key) {
    setSelectedESDKeys(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  }

  // State for mass edit modal
  // (already declared at the top)

  // Handler for dropdown changes in mass edit modal
  function handleMassEditChange(field, value) {
    setMassEditModal(prev => ({ ...prev, [field]: value }));
  }

  // Handler to submit mass update
  async function submitMassEditModal() {
    setMassEditModal(prev => ({ ...prev, loading: true, error: null }));
    try {
      const accessToken = localStorage.getItem('accessToken');
      const subdomain = localStorage.getItem('subdomain');
      // Always use CustomerKey for these fields
      const sendClassificationKey = getCustomerKey(sendClassifications, massEditModal.sendClassification);
      const senderProfileKey = getCustomerKey(senderProfiles, massEditModal.senderProfile);
      const deliveryProfileKey = getCustomerKey(deliveryProfiles, massEditModal.deliveryProfile);
      const res = await fetch(`${baseURL}/update/emailsenddefinition-mass`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'x-mc-subdomain': subdomain
        },
        body: JSON.stringify({
          CustomerKeys: selectedESDKeys,
          SendClassification: sendClassificationKey,
          SenderProfile: senderProfileKey,
          DeliveryProfile: deliveryProfileKey
        })
      });
      const data = await res.json();
      if (data.status === 'OK') {
        setMassEditModal({ open: false, sendClassification: '', senderProfile: '', deliveryProfile: '', loading: false, error: null });
        setSelectedESDKeys([]);
        alert('✅ Bulk update successful');
        await refreshResolvedEmailSendDefs();
      } else {
        setMassEditModal(prev => ({ ...prev, loading: false, error: data.message || 'Update failed' }));
        alert('❌ Bulk update failed: ' + (data.message || 'Unknown error'));
      }
    } catch (err) {
      setMassEditModal(prev => ({ ...prev, loading: false, error: err.message }));
      alert('❌ Bulk update failed: ' + err.message);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center h-screen bg-gray-100">
        <div className="p-8 bg-white rounded-lg shadow-lg text-center max-w-md">
          <div className="mb-4 animate-spin inline-block">
            <svg className="w-8 h-8 text-indigo-600" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"></path>
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-indigo-700">Loading data, please wait...</h2>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex justify-center items-center h-screen bg-gray-100">
        <div className="p-8 bg-white rounded-lg shadow-lg text-center max-w-md">
          <h1 className="text-2xl font-bold text-indigo-700 mb-4">Welcome to MC Explorer</h1>
          <p className="mb-4 text-gray-700">
            Click below to login with your Marketing Cloud user
          </p>
          <a
            href={`${baseURL}/auth/login`}
            className="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700"
          >
            Login with Marketing Cloud
          </a>
        </div>
      </div>
    );
  }

  // Render navigation tabs
  const renderNavigation = () => (
    <div className="flex space-x-4 mb-6">
      <button
        className={`px-4 py-2 rounded-lg ${activeTab === 'de' ? 'bg-indigo-600 text-white' : 'bg-gray-200 hover:bg-gray-300'}`}
        onClick={() => setActiveTab('de')}
      >
        Data Extensions
      </button>
      <button
        className={`px-4 py-2 rounded-lg ${activeTab === 'dm' ? 'bg-indigo-600 text-white' : 'bg-gray-200 hover:bg-gray-300'}`}
        onClick={() => setActiveTab('dm')}
      >
        Distributed Marketing
      </button>
    </div>
  );

  // Render main content for DM Quick Send
  const renderDMQuickSend = () => (
    <div>
      <h2 className="text-2xl font-semibold text-indigo-700 mb-6">
        Single Click Distributed Marketing Quick Send Journey Setup
      </h2>
      <button
        onClick={async () => {
          setQSLoading(true);
          setQSStatus("Creating Quick Send DE, Event, Journey...");
          setQSDetails(null);
          try {
            const res = await fetch(`${baseURL}/create/dm-dataextension`, { method: 'POST' });
            const json = await res.json();
            if (json.status === "OK") {
              setQSStatus("✅ All set!");
              setQSDetails({
                deName: json.deName,
                dePath: json.folderName ? `/Data Extensions / ${json.folderName}` : '',
                eventName: json.eventName || json.eventDefinitionKey || '',
                journeyName: json.journeyName || '',
              });
            } else {
              setQSStatus("❌ Setup failed.");
            }
          } catch (e) {
            setQSStatus("❌ Error during setup.");
          } finally {
            setQSLoading(false);
          }
        }}
        disabled={qsLoading}
        className={`mt-4 px-6 py-2 rounded-md ${qsLoading ? 'bg-gray-400 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700'} text-white`}
      >
        {qsLoading ? 'Processing...' : 'Create DM QS'}
      </button>
      <div className="mt-6 text-gray-700 space-y-2">
        {qsStatus && <p className="text-lg font-medium">{qsStatus}</p>}
        {qsDetails && (
          <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
            <p>🔹 <strong>QS DE name:</strong> {qsDetails.deName}</p>
            {qsDetails.dePath && <p>🔹 <strong>QS DE path:</strong> {qsDetails.dePath}</p>}
            {qsDetails.eventName && <p>🔹 <strong>QS Event name:</strong> {qsDetails.eventName}</p>}
            {qsDetails.journeyName && <p>🔹 <strong>QS Journey name:</strong> {qsDetails.journeyName}</p>}
            <p>🔹 <strong>Now go ahead and update the Journey with the email activity.</strong></p>
            <p>🔹 <strong>Edit the journey settings to select contact re-entry mode and email attribute from Entry Source.</strong></p>
            <p>🔹 <strong>Validate and activate the journey.</strong></p>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-100">
      {/* App Title and Header */}
      <div id="mc-explorer-root" className="bg-white rounded-xl shadow-lg p-6 mt-6 mb-8 mx-auto" style={{maxWidth: '1100px'}}>
        <header className="bg-indigo-800 text-white p-4 shadow flex items-center gap-4 rounded-t-lg">
          <img src={require('./logo.svg').default} alt="MC Explorer Logo" className="h-10 w-10" />
          <h1 className="text-2xl font-bold tracking-wide" style={{ color: '#61DAFB', letterSpacing: '0.04em' }}>MC Explorer</h1>
        </header>
        {/* Parent Navigation */}
        <div className="flex gap-4 p-4 bg-white shadow mb-4 rounded-b-lg">
          <button
            className={`px-4 py-2 rounded text-sm font-semibold ${parentNav === 'search' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-800 border'}`}
            onClick={() => setParentNav('search')}
          >
            Search Assets
          </button>
          <button
            className={`px-4 py-2 rounded text-sm font-semibold ${parentNav === 'preference' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-800 border'}`}
            onClick={() => setParentNav('preference')}
          >
            Guided Preference Center
          </button>
          <button
            className={`px-4 py-2 rounded text-sm font-semibold ${parentNav === 'distributedMarketing' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-800 border'}`}
            onClick={() => setParentNav('distributedMarketing')}
          >
            Distributed Marketing
          </button>
        </div>
        {/* Render content based on parentNav */}
        {parentNav === 'search' ? (
          <>
            <div className="flex justify-between items-center mb-4">
              <h1 className="text-3xl font-bold text-indigo-700">MC Explorer</h1>
              <button onClick={handleLogout} className="text-sm bg-red-500 px-3 py-1 rounded text-white">
                Logout
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
              <div className="bg-white rounded shadow p-4">
                <div className="text-lg font-bold text-indigo-700">Data Extensions</div>
                <div className="text-2xl font-bold">{dataExtensions.length}</div>
                <div className="text-xs text-gray-500 mt-2">Last 7d: {deGroups.last7} | 30d: {deGroups.last30} | 6mo: {deGroups.last180} | 1yr: {deGroups.last365}</div>
              </div>
              <div className="bg-white rounded shadow p-4">
                <div className="text-lg font-bold text-indigo-700">Automations</div>
                <div className="text-2xl font-bold">{automations.length}</div>
                <div className="text-xs text-gray-500 mt-2">Last 7d: {autoGroups.last7} | 30d: {autoGroups.last30} | 6mo: {autoGroups.last180} | 1yr: {autoGroups.last365}</div>
              </div>
              <div className="bg-white rounded shadow p-4">
                <div className="text-lg font-bold text-indigo-700">Data Filters</div>
                <div className="text-2xl font-bold">{dataFilters.length}</div>
                <div className="text-xs text-gray-500 mt-2">Last 7d: {dfGroups.last7} | 30d: {dfGroups.last30} | 6mo: {dfGroups.last180} | 1yr: {dfGroups.last365}</div>
              </div>
              <div className="bg-white rounded shadow p-4">
                <div className="text-lg font-bold text-indigo-700">Journeys</div>
                <div className="text-2xl font-bold">{journeys.length}</div>
                <div className="text-xs text-gray-500 mt-2">Last 7d: {journeyGroups.last7} | 30d: {journeyGroups.last30} | 6mo: {journeyGroups.last180} | 1yr: {journeyGroups.last365}</div>
              </div>
              <div className="bg-white rounded shadow p-4">
                <div className="text-lg font-bold text-indigo-700">Publications</div>
                <div className="text-2xl font-bold">{publications.length}</div>
                <div className="text-xs text-gray-500 mt-2">Last 7d: {pubGroups.last7} | 30d: {pubGroups.last30} | 6mo: {pubGroups.last180} | 1yr: {pubGroups.last365}</div>
              </div>
            </div>

            {/* Responsive search bar row */}
            <div className="w-full flex flex-col sm:flex-row items-stretch sm:items-center gap-2 mb-2">
              <input
                type="text"
                placeholder="Search..."
                className="border px-3 py-2 rounded w-full sm:w-64"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                style={{ maxWidth: 320 }}
              />
            </div>
            {/* Tab buttons and CSV download */}
            <div className="flex flex-wrap gap-2 mb-4 items-center">
              {['de', 'automation', 'datafilter', 'journey', 'emailsenddefinition', 'publication'].map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2 rounded text-sm ${activeTab === tab ? 'bg-indigo-600 text-white' : 'bg-white text-gray-800 border'}`}
                >
                  {tab === 'emailsenddefinition' ? 'EmailSendDefinition' : tab.toUpperCase()}
                </button>
              ))}
              <button
                onClick={downloadCSV}
                className="bg-green-600 text-white px-3 py-1 rounded text-sm ml-2"
              >
                Download CSV
              </button>
            </div>

            <div className="overflow-x-auto bg-white shadow rounded">
              {activeTab === 'emailsenddefinition' ? (
                <div className="bg-white shadow rounded p-4 mt-4">
                  <h2 className="text-xl font-bold mb-4 text-indigo-700">EmailSendDefinition Details</h2>
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr>
                          <th className="p-2">
                            <input type="checkbox" checked={allSelected} onChange={toggleSelectAllESD} />
                          </th>
                          <th className="text-left p-2">Name</th>
                          <th className="text-left p-2">SendClassification</th>
                          <th className="text-left p-2">SenderProfile</th>
                          <th className="text-left p-2">DeliveryProfile</th>
                          <th className="text-left p-2">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(searchTerm ? getFilteredData().filter(item => item._type === 'EmailSendDefinition') : resolvedEmailSendDefs).map((esd, idx) => (
                          <tr key={esd.CustomerKey} className="border-t">
                            <td className="p-2">
                              <input type="checkbox" checked={selectedESDKeys.includes(esd.CustomerKey)} onChange={() => toggleSelectESD(esd.CustomerKey)} />
                            </td>
                            <td className="p-2 font-medium">{esd.Name}</td>
                            <td className="p-2">{getProfileName(sendClassifications, esd.SendClassification?.CustomerKey)}</td>
                            <td className="p-2">{getProfileName(senderProfiles, esd.SenderProfile?.CustomerKey)}</td>
                            <td className="p-2">{getProfileName(deliveryProfiles, esd.DeliveryProfile?.CustomerKey)}</td>
                            <td className="p-2">
                              <button className="text-blue-600 hover:underline mr-2" onClick={() => openEditESDModal(esd)}>
                                <span role="img" aria-label="Edit">✏️</span>
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {selectedESDKeys.length > 0 && (
                    <button
                      className="mt-2 px-4 py-2 bg-blue-700 text-white rounded font-semibold"
                      onClick={() => setMassEditModal({ open: true, sendClassification: '', senderProfile: '', deliveryProfile: '', loading: false, error: null })}
                    >
                      Bulk Edit Selected ({selectedESDKeys.length})
                    </button>
                  )}
                  {/* Debug block and other details remain hidden */}
                </div>
              ) : activeTab === 'publication' ? (
                <div className="bg-white shadow rounded p-4 mt-4">
                  <h2 className="text-xl font-bold mb-4 text-indigo-700">Publication Details</h2>
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr>
                          <th className="text-left p-2">ID</th>
                          <th className="text-left p-2">Name</th>
                          <th className="text-left p-2">Category</th>
                          <th className="text-left p-2">CustomerKey</th>
                          <th className="text-left p-2">BusinessUnit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(searchTerm ? getFilteredData().filter(item => item._type === 'Publication') : publications).map((pub, idx) => (
                          <tr key={pub.id || idx} className="border-t">
                            <td className="p-2">{pub.id}</td>
                            <td className="p-2 font-medium">{pub.name}</td>
                            <td className="p-2">{pub.category}</td>
                            <td className="p-2">{pub.customerKey || ''}</td>
                            <td className="p-2">{pub.businessUnit || ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                // ...existing code for other tabs and search...
                <table className="min-w-full text-sm">
                  <thead>
                    <tr>
                      <th className="text-left p-2">Type</th>
                      <th className="text-left p-2 cursor-pointer" onClick={() => requestSort('name')}>Name</th>
                      {/* Remove Created column for Automations */}
                      <th className="text-left p-2 cursor-pointer" onClick={() => requestSort('path')}>Path</th>
                      {/* Hide 'View in folder' column for Automation and Journey */}
                      {!(activeTab === 'automation' || activeTab === 'journey') && (
                        <th className="text-left p-2">View in folder</th>
                      )}
                      {(!searchTerm && (activeTab === 'automation' || activeTab === 'journey')) || (searchTerm && getFilteredData().some(item => item._type === 'Automation' || item._type === 'Journey')) ? (
                        <th className="text-left p-2 cursor-pointer" onClick={() => requestSort('status')}>Status</th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedData().map((item, idx) => (
                      <tr key={idx} className={`border-t ${item._type === 'Data Extension' ? 'cursor-pointer hover:bg-indigo-50' : item._type === 'Automation' ? 'cursor-pointer hover:bg-green-50' : ''}`}
                        onClick={() => {
                          if (item._type === 'Data Extension') fetchDeDetails(item.name);
                          if (item._type === 'Automation') fetchAutomationDetails(item.name, item.id);
                        }}
                      >
                        <td className="p-2">{item._type}</td>
                        <td className="p-2 font-medium">{item.name}</td>
                        {/* Remove Created column for Automations */}
                        <td className="p-2">{item.path || 'N/A'}</td>
                        {/* Hide 'View in folder' cell for Automation and Journey */}
                        {!(item._type === 'Automation' || item._type === 'Journey') && (
                          <td className="p-2">
                            {/* Existing View in folder links for DE and Data Filter */}
                            {item._type === 'Data Extension' && item.categoryId && item.id && (
                              <a
                                href={`https://mc.s4.exacttarget.com/cloud/#app/Email/C12/Default.aspx?entityType=none&entityID=0&ks=ks%23Subscribers/CustomObjects/${item.categoryId}/?ts=${item.id}/view`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 underline hover:text-blue-800"
                                onClick={e => e.stopPropagation()}
                              >
                                View
                              </a>
                            )}
                            {item._type === 'Data Filter' && item.id && (
                              <a
                                href={`https://mc.s4.exacttarget.com/cloud/#app/Email/C12/Default.aspx?entityType=none&entityID=0&ks=ks%23Subscribers/filters/${item.id}/view`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 underline hover:text-blue-800 ml-2"
                                onClick={e => e.stopPropagation()}
                              >
                                View
                              </a>
                            )}
                          </td>
                        )}
                        {((!searchTerm && (activeTab === 'automation' || activeTab === 'journey')) || (searchTerm && (item._type === 'Automation' || item._type === 'Journey'))) && (
                          <td className="p-2">{item.status || 'N/A'}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="flex justify-between items-center mt-4 text-sm">
              <div>
                Page {currentPage} of {totalPages}
              </div>
              <div className="flex gap-2">
                <button disabled={currentPage === 1} onClick={() => setCurrentPage(p => p - 1)} className="px-2 py-1 border rounded">Prev</button>
                <button disabled={currentPage === totalPages || totalPages <= 1} onClick={() => setCurrentPage(p => p + 1)} className="px-2 py-1 border rounded">Next</button>
              </div>
            </div>

            {/* Modal for DE details */}
            {deDetailModal.open && (
              <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
                <div className="bg-white rounded-lg shadow-lg p-6 min-w-[320px] max-w-[90vw] relative">
                  <button className="absolute top-2 right-2 text-gray-500 hover:text-red-600" onClick={() => setDeDetailModal({ open: false, loading: false, error: null, details: null, name: null })}>&#10005;</button>
                  <h2 className="text-lg font-bold mb-4 text-indigo-700">Data Extension Details: {deDetailModal.name}</h2>
                  {deDetailModal.loading && <div className="text-center py-4">Loading details...</div>}
                  {deDetailModal.error && <div className="text-red-600">{deDetailModal.error}</div>}
                  {deDetailModal.details && (
                    <div className="space-y-2">
                      <div><span className="font-semibold">Created By:</span> {deDetailModal.details.createdByName}</div>
                      <div><span className="font-semibold">Modified By:</span> {deDetailModal.details.modifiedByName}</div>
                      <div><span className="font-semibold">Row Count:</span> {deDetailModal.details.rowCount}</div>
                      <div><span className="font-semibold">Is Sendable:</span> {deDetailModal.details.isSendable.toString()}</div>
                      <div><span className="font-semibold">Is Testable:</span> {deDetailModal.details.isTestable.toString()}</div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Modal for Automation details */}
            {automationDetailModal.open && (
              <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
                <div className="bg-white rounded-lg shadow-lg p-6 min-w-[320px] max-w-[90vw] relative">
                  <button className="absolute top-2 right-2 text-gray-500 hover:text-red-600" onClick={() => setAutomationDetailModal({ open: false, loading: false, error: null, details: null, name: null })}>&#10005;</button>
                  <h2 className="text-lg font-bold mb-4 text-green-700">Automation Details: {automationDetailModal.name}</h2>
                  {automationDetailModal.loading && <div className="text-center py-4">Loading details...</div>}
                  {automationDetailModal.error && <div className="text-red-600">{automationDetailModal.error}</div>}
                  {automationDetailModal.details && (
                    <div className="space-y-2">
                      <div><span className="font-semibold">Start Date:</span> {automationDetailModal.details.startDate}</div>
                      <div><span className="font-semibold">End Date:</span> {automationDetailModal.details.endDate}</div>
                      <div><span className="font-semibold">Last Run Time:</span> {automationDetailModal.details.lastRunTime}</div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Modal for SendClassification details */}
            {sendClassModal.open && (
              <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
                <div className="bg-white rounded-lg shadow-lg p-6 min-w-[320px] max-w-[90vw] relative">
                  <button className="absolute top-2 right-2 text-gray-500 hover:text-red-600" onClick={() => setSendClassModal({ open: false, loading: false, error: null, details: null, name: null })}>&#10005;</button>
                  <h2 className="text-lg font-bold mb-4 text-indigo-700">SendClassification Details: {sendClassModal.name}</h2>
                  {sendClassModal.loading && <div className="text-center py-4">Loading details...</div>}
                  {sendClassModal.error && <div className="text-red-600">{sendClassModal.error}</div>}
                  {sendClassModal.details && Array.isArray(sendClassModal.details) && sendClassModal.details.length > 0 && (
                    <div className="space-y-2">
                      <div><span className="font-semibold">Name:</span> {sendClassModal.details[0].Name}</div>
                      <div><span className="font-semibold">CustomerKey:</span> {sendClassModal.details[0].CustomerKey}</div>
                      <div><span className="font-semibold">Description:</span> {sendClassModal.details[0].Description}</div>
                    </div>
                  )}
                  {sendClassModal.details && Array.isArray(sendClassModal.details) && sendClassModal.details.length === 0 && (
                    <div className="text-gray-600">No details found for this SendClassification.</div>
                  )}
                </div>
              </div>
            )}

            {/* Modal for SenderProfile details */}
            {senderProfileModal.open && (
              <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
                <div className="bg-white rounded-lg shadow-lg p-6 min-w-[320px] max-w-[90vw] relative">
                  <button className="absolute top-2 right-2 text-gray-500 hover:text-red-600" onClick={() => setSenderProfileModal({ open: false, loading: false, error: null, details: null, name: null })}>&#10005;</button>
                  <h2 className="text-lg font-bold mb-4 text-green-700">SenderProfile Details: {senderProfileModal.name}</h2>
                  {senderProfileModal.loading && <div className="text-center py-4">Loading details...</div>}
                  {senderProfileModal.error && <div className="text-red-600">{senderProfileModal.error}</div>}
                  {senderProfileModal.details && Array.isArray(senderProfileModal.details) && senderProfileModal.details.length > 0 && (
                    <div className="space-y-2">
                      <div><span className="font-semibold">Name:</span> {senderProfileModal.details[0].Name}</div>
                      <div><span className="font-semibold">CustomerKey:</span> {senderProfileModal.details[0].CustomerKey}</div>
                      <div><span className="font-semibold">Description:</span> {senderProfileModal.details[0].Description}</div>
                    </div>
                  )}
                  {senderProfileModal.details && Array.isArray(senderProfileModal.details) && senderProfileModal.details.length === 0 && (
                    <div className="text-gray-600">No details found for this SenderProfile.</div>
                  )}
                </div>
              </div>
            )}

            {/* Modal for updating SenderProfile */}
            {updateSenderProfileModal.open && (
              <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
                <div className="bg-white rounded-lg shadow-lg p-6 min-w-[320px] max-w-[90vw] relative">
                  <button className="absolute top-2 right-2 text-gray-500 hover:text-red-600" onClick={() => setUpdateSenderProfileModal({ open: false, loading: false, error: null, customerKey: null, selectedKey: '', success: false })}>&#10005;</button>
                  <h2 className="text-lg font-bold mb-4 text-yellow-700">Update SenderProfile</h2>
                  {updateSenderProfileModal.loading && <div className="text-center py-4">Updating...</div>}
                  {updateSenderProfileModal.error && <div className="text-red-600">{updateSenderProfileModal.error}</div>}
                  {updateSenderProfileModal.success && <div className="text-green-600">SenderProfile updated successfully!</div>}
                  <div className="mb-4">
                    <label className="block mb-2 font-semibold">Select new SenderProfile:</label>
                    <select
                      className="border rounded px-3 py-2 w-full"
                      value={updateSenderProfileModal.selectedKey}
                      onChange={e => setUpdateSenderProfileModal(modal => ({ ...modal, selectedKey: e.target.value }))}
                    >
                      <option value="" disabled>Select SenderProfile...</option>
                      {senderProfiles.map(profile => (
                        <option key={profile.CustomerKey} value={profile.CustomerKey}>{profile.Name} ({profile.CustomerKey})</option>
                      ))}
                    </select>
                  </div>
                  <button
                    className="bg-yellow-600 text-white px-4 py-2 rounded font-semibold hover:bg-yellow-700"
                    onClick={handleUpdateSenderProfile}
                    disabled={!updateSenderProfileModal.selectedKey || updateSenderProfileModal.loading}
                  >
                    Update
                  </button>
                </div>
              </div>
            )}

            {/* Modal for editing EmailSendDefinition */}
            {editESDModal.open && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-30">
                <div className="bg-white rounded shadow-lg p-6 w-full max-w-md relative">
                  <h2 className="text-lg font-bold mb-4">Edit EmailSendDefinition</h2>
                  {editESDModal.error && <div className="text-red-600 mb-2">{editESDModal.error}</div>}
                  <div className="mb-4">
                    <label className="block mb-1 font-semibold">Send Classification</label>
                    <select
                      className="w-full border rounded p-2"
                      value={editESDModal.sendClassification}
                      onChange={e => handleEditESDChange('sendClassification', e.target.value)}
                    >
                      <option value="">Select SendClassification</option>
                      {sendClassifications.map(sc => (
                        <option key={sc.CustomerKey} value={sc.CustomerKey}>{sc.Name || sc.CustomerKey}</option>
                      ))}
                    </select>
                  </div>
                  <div className="mb-4">
                    <label className="block mb-1 font-semibold">Sender Profile</label>
                    <select
                      className="w-full border rounded p-2"
                      value={editESDModal.senderProfile}
                      onChange={e => handleEditESDChange('senderProfile', e.target.value)}
                    >
                      <option value="">Select SenderProfile</option>
                      {senderProfiles.map(sp => (
                        <option key={sp.CustomerKey} value={sp.CustomerKey}>{sp.Name || sp.CustomerKey}</option>
                      ))}
                    </select>
                  </div>
                  <div className="mb-4">
                    <label className="block mb-1 font-semibold">Delivery Profile</label>
                    <select
                      className="w-full border rounded p-2"
                      value={editESDModal.deliveryProfile}
                      onChange={e => handleEditESDChange('deliveryProfile', e.target.value)}
                    >
                      <option value="">Select DeliveryProfile</option>
                      {deliveryProfiles.map(dp => (
                        <option key={dp.CustomerKey} value={dp.CustomerKey}>{dp.Name || dp.CustomerKey}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button onClick={closeEditESDModal} className="px-4 py-2 bg-gray-200 rounded">Cancel</button>
                    <button onClick={submitEditESDModal} className="px-4 py-2 bg-blue-600 text-white rounded" disabled={editESDModal.loading}>
                      {editESDModal.loading ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Bulk Edit Modal */}
            {massEditModal.open && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-30">
                <div className="bg-white rounded shadow-lg p-6 w-full max-w-md relative">
                  <h2 className="text-lg font-bold mb-4">Bulk Edit EmailSendDefinitions</h2>
                  {massEditModal.error && <div className="text-red-600 mb-2">{massEditModal.error}</div>}
                  <div className="mb-4">
                    <label className="block mb-1 font-semibold">Send Classification</label>
                    <select
                      className="w-full border rounded p-2"
                      value={massEditModal.sendClassification}
                      onChange={e => setMassEditModal(prev => ({ ...prev, sendClassification: e.target.value }))}
                    >
                      <option value="">(No Change)</option>
                      {sendClassifications.map(sc => (
                        <option key={sc.CustomerKey} value={sc.CustomerKey}>{sc.Name || sc.CustomerKey}</option>
                      ))}
                    </select>
                  </div>
                  <div className="mb-4">
                    <label className="block mb-1 font-semibold">Sender Profile</label>
                    <select
                      className="w-full border rounded p-2"
                      value={massEditModal.senderProfile}
                      onChange={e => setMassEditModal(prev => ({ ...prev, senderProfile: e.target.value }))}
                    >
                      <option value="">(No Change)</option>
                      {senderProfiles.map(sp => (
                        <option key={sp.CustomerKey} value={sp.CustomerKey}>{sp.Name || sp.CustomerKey}</option>
                      ))}
                    </select>
                  </div>
                  <div className="mb-4">
                    <label className="block mb-1 font-semibold">Delivery Profile</label>
                    <select
                      className="w-full border rounded p-2"
                      value={massEditModal.deliveryProfile}
                      onChange={e => setMassEditModal(prev => ({ ...prev, deliveryProfile: e.target.value }))}
                    >
                      <option value="">(No Change)</option>
                      {deliveryProfiles.map(dp => (
                        <option key={dp.CustomerKey} value={dp.CustomerKey}>{dp.Name || dp.CustomerKey}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setMassEditModal({ open: false, sendClassification: '', senderProfile: '', deliveryProfile: '', loading: false, error: null })} className="px-4 py-2 bg-gray-200 rounded">Cancel</button>
                    <button onClick={submitMassEditModal} className="px-4 py-2 bg-blue-600 text-white rounded" disabled={massEditModal.loading}>
                      {massEditModal.loading ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Show DE info block after creation */}
            {dmDEPath && (() => {
              let deName = '';
              if (dmDEPath) {
                const parts = dmDEPath.split('/');
                deName = parts[parts.length - 1];
              }
              return (
                <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded">
                  <div className="text-green-800 font-bold mb-2">Data Extension created!</div>
                  <div className="mb-2 text-gray-800">
                    <span className="font-semibold">Your data extension name is:</span> <span className="font-mono text-blue-900">{deName || 'N/A'}</span>
                  </div>
                  <div className="mb-2 text-gray-800">
                    <span className="font-semibold">The data extension path is:</span> <span className="font-mono text-blue-900">Data Extensions &gt; {deName || 'N/A'}</span>
                  </div>
                  <div className="mb-2 text-gray-800">
                    <span className="font-semibold">We have set the below attributes in the data extension:</span>
                    <ul className="list-disc ml-6 mt-1">
                      <li><span className="font-semibold">USED FOR SENDING: Yes</span></li>
                      <li><span className="font-semibold">USED FOR TESTING: Yes</span></li>
                      <li><span className="font-semibold">SUBSCRIBER RELATIONSHIP: id relates to Subscribers on Subscriber Key</span></li>
                    </ul>
                  </div>
                </div>
              );
            })()}
          </>
        ) : parentNav === 'preference' ? (
          <div className="p-6 bg-white rounded shadow">
            <h2 className="text-xl font-bold mb-4 text-indigo-700">How do you want your preference center to be set up?</h2>
            <select
              className="border rounded px-3 py-2 w-full mb-6"
              value={guidedPrefOption || ''}
              onChange={e => setGuidedPrefOption(e.target.value)}
            >
              <option value="" disabled>Select an option...</option>
              <option value="no_sf_core">Marketing Cloud Preference Center with no Salesforce core integration</option>
              <option value="sf_core_contact_lead">Marketing Cloud Preference Center with Salesforce core contact, Lead integration</option>
              <option value="sf_core_consent">Marketing Cloud Preference Center with Salesforce core consent model</option>
            </select>

            {guidedPrefOption === 'no_sf_core' && (
              <div className="mt-6 text-left">
                <a
                  href="/Custom%20Preference%20Center_No_SF_Integration.zip"
                  download
                  className="inline-block bg-indigo-600 text-white px-4 py-2 rounded font-semibold mb-4 hover:bg-indigo-700"
                >
                  Download Preference Center Package (ZIP)
                </a>
                <div className="bg-gray-50 border-l-4 border-indigo-400 p-4 rounded">
                  <h3 className="font-bold mb-2 text-indigo-700">Instructions</h3>
                  <ol className="list-decimal ml-6 text-sm text-gray-800 space-y-1">
                    <li>In the <b>Package Manager</b> folder, deploy the JSON into SFMC via Package Manager.</li>
                    <li>Go into the Cloud pages and do a search all and replace for the cloudpageURL IDs; there will be 2-3 that did not get deployed correctly.</li>
                    <li>In <b>cpc_main</b> on line 301, ensure that the cloud page ID is for <b>cpc_main</b>.</li>
                    <li>In <b>cpc_main</b> on line 331, ensure that the cloud page ID is for <b>cpc_handler</b>.</li>
                    <li>In <b>cpc_handler</b>, every <b>CloudPagesURL</b> function should point to the cloud page ID for <b>cpc_main</b>.</li>
                    <li>Test, validate, and add additional features as needed.</li>
                    <li>To use the preference center, the url expects a <b>subkey</b> parameter at the end of the URL (e.g. <span className="break-all">https://mcf7bhdjzswk278tj2j38nqtlq2q.pub.sfmc-content.com/jqi02yqkmgp?subkey=TEST10001</span>).</li>
                  </ol>
                  <div className="mt-2 text-xs text-gray-600">
                    <b>NOTE:</b> The preference center assumes that a record with email exists in All Subscribers.
                  </div>
                </div>
              </div>
            )}

            {guidedPrefOption === 'sf_core_contact_lead' && (
              <div className="mt-6 text-left text-gray-600">
                <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 rounded">
                  <b>Coming soon:</b> Marketing Cloud Preference Center with Salesforce core contact, Lead integration is in development.
                </div>
              </div>
            )}

            {guidedPrefOption === 'sf_core_consent' && (
              <div className="mt-6 text-left text-gray-600">
                <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 rounded">
                  <b>Coming soon:</b> Marketing Cloud Preference Center with Salesforce core consent model is in development.
                </div>
              </div>
            )}
          </div>
        ) : parentNav === 'distributedMarketing' ? (
          <div className="bg-white shadow rounded p-6 max-w-xl mx-auto">
            {renderDMQuickSend()}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function formatDate(dateStr) {
  if (!dateStr || dateStr === 'N/A' || dateStr === 'Not Available') return 'N/A';
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleString('en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).replace(',', '');
}
