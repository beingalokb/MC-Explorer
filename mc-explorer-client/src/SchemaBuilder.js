import React, { useState, useRef, useEffect, useCallback } from 'react';
import CytoscapeComponent from 'react-cytoscapejs';
import SchemaCardBoard from './components/SchemaCardBoard';

// API functions for backend integration
const fetchGraphData = async (selectedObjects = {}) => {
  try {
    const params = new URLSearchParams();
    
    // Send selected objects as JSON string
    if (Object.keys(selectedObjects).length > 0) {
      params.append('selectedObjects', JSON.stringify(selectedObjects));
    }
    
    const response = await fetch(`/graph?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Error fetching graph data:', error);
    throw error;
  }
};

const fetchNodeDetails = async (nodeId) => {
  try {
    const response = await fetch(`/graph/node/${nodeId}`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Error fetching node details:', error);
    throw error;
  }
};

// New: fetch expansion data for a node (1-hop dependencies and orchestrators)
const fetchExpandDependencies = async (nodeId) => {
  try {
    const response = await fetch(`/graph/expand/${nodeId}`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Error expanding node dependencies:', error);
    throw error;
  }
};

const fetchObjects = async () => {
  try {
    const response = await fetch('/objects');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Error fetching objects:', error);
    throw error;
  }
};

const SchemaBuilder = () => {
  const [selectedObjects, setSelectedObjects] = useState({});
  const [expandedCategories, setExpandedCategories] = useState({});
  const [graphElements, setGraphElements] = useState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  
  // New: view mode toggle (cards vs graph)
  const [viewMode, setViewMode] = useState('cards'); // 'cards' | 'graph'
  
  // New: flag for explicitly showing all objects
  const [showAllObjects, setShowAllObjects] = useState(false);
  
  // API state
  const [apiLoading, setApiLoading] = useState(false);
  const [apiError, setApiError] = useState(null);
  
  // New: Loading state specifically for right side when selections change
  const [rightSideLoading, setRightSideLoading] = useState(false);
  
  // Objects data state
  const [objectData, setObjectData] = useState({});
  const [objectsLoading, setObjectsLoading] = useState(false);
  const [objectsError, setObjectsError] = useState(null);
  
  // Search functionality
  const [searchTerm, setSearchTerm] = useState('');
  const [filteredObjectData, setFilteredObjectData] = useState({});
  
  // Debug and filtering controls
  const [debugInfo, setDebugInfo] = useState({});
  const [relationshipStats, setRelationshipStats] = useState({});
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [highlightedElements, setHighlightedElements] = useState(new Set());
  const [hoveredNodeId, setHoveredNodeId] = useState(null);
  const [automationSteps, setAutomationSteps] = useState([]);
  const [hoveredStepIndex, setHoveredStepIndex] = useState(null);

  // New: extra graph state from dependency expansion
  const [extraGraph, setExtraGraph] = useState({ nodes: [], edges: [] });
  const [isExpanding, setIsExpanding] = useState(false);

  const cyRef = useRef(null);

  // Filter objects based on search term
  useEffect(() => {
    if (!searchTerm.trim()) {
      setFilteredObjectData(objectData);
      return;
    }
    
    const filtered = {};
    const searchLower = searchTerm.toLowerCase();
    
    Object.entries(objectData).forEach(([category, objects]) => {
      const filteredObjects = objects.filter(obj => 
        obj.name.toLowerCase().includes(searchLower) ||
        obj.description?.toLowerCase().includes(searchLower) ||
        obj.externalKey?.toLowerCase().includes(searchLower)
      );
      
      if (filteredObjects.length > 0) {
        filtered[category] = filteredObjects;
      }
    });
    
    setFilteredObjectData(filtered);
  }, [objectData, searchTerm]);

  const objectTypes = Object.keys(filteredObjectData);

  // Check if any objects are selected
  const hasSelectedObjects = Object.values(selectedObjects).some(categoryObj => 
    Object.values(categoryObj || {}).some(selected => selected)
  );

  // Color mapping for different object types (following your specification)
const OBJECT_TYPE_COLORS = {
  'Data Extensions': '#3B82F6',    // 🟦 Blue
  'SQL Queries': '#10B981',       // 🟩 Green  
  'Automations': '#F97316',       // 🟧 Orange
  'Journeys': '#8B5CF6',          // 🟪 Purple
  'Triggered Sends': '#EF4444',   // 🟥 Red
  'File Transfers': '#EAB308',    // 🟨 Yellow
  'Data Extracts': '#A16207',     // 🟫 Brown
  'Filters': '#06B6D4'            // 🟦 Cyan (keeping as distinguishable blue)
};

// Get color for object type
const getObjectTypeColor = (category) => {
  return OBJECT_TYPE_COLORS[category] || '#6B7280'; // Default gray
};

// Get node color based on type/category
const getNodeColor = (type) => {
  const typeMapping = {
    'Data Extensions': '#3B82F6',    // Blue
    'SQL Queries': '#10B981',       // Green  
    'Automations': '#F97316',       // Orange
    'Journeys': '#8B5CF6',          // Purple
    'Triggered Sends': '#EF4444',   // Red
    'File Transfers': '#EAB308',    // Yellow
    'Data Extracts': '#A16207',     // Brown
    'Filters': '#06B6D4',           // Cyan
    'DataExtension': '#3B82F6',
    'Query': '#10B981',
    'Automation': '#F97316',
    'Journey': '#8B5CF6',
    'TriggeredSend': '#EF4444',
    'FileTransfer': '#EAB308',
    'DataExtract': '#A16207',
    'Filter': '#06B6D4'
  };
  return typeMapping[type] || '#6B7280'; // Default gray
};

// Enhanced edge styling based on relationship type and connection level
const getEdgeStyle = (relationshipType, isDirect = true, isHighlighted = false, isFaded = false) => {
  const edgeColors = {
    // Direct data flow relationships
    'writes_to': '#10B981',           // Green for data writes
    'reads_from': '#3B82F6',         // Blue for data reads
    'imports_to_de': '#F97316',      // Orange for data imports
    'updates_de': '#84CC16',         // Lime for updates
    
    // Automation and workflow relationships
    'contains_query': '#6B7280',     // Gray for containment
    'contains_filter': '#06B6D4',    // Cyan for filter containment
    'executes_query': '#8B5CF6',     // Purple for execution
    'triggers_automation': '#EC4899', // Pink for triggers
    
    // Journey and campaign relationships
    'journey_entry_source': '#8B5CF6', // Purple for journey entries
    'uses_in_decision': '#EAB308',   // Yellow for decision logic
    'subscriber_source': '#EF4444',  // Red for email sources
    'sends_email': '#EC4899',        // Pink for email sends
    
    // Filter and metadata relationships
    'filters_de': '#06B6D4',         // Cyan for filtering
    'provides_data_to': '#06B6D4',   // Cyan for data flow
    
    'default': '#94A3B8'             // Default gray
  };
  
  const baseColor = edgeColors[relationshipType] || edgeColors.default;
  
  return {
    'line-color': isFaded ? `${baseColor}40` : baseColor,
    'target-arrow-color': isFaded ? `${baseColor}40` : baseColor,
    'target-arrow-shape': 'triangle',
    'target-arrow-size': isHighlighted ? '15px' : '12px',
    'curve-style': 'bezier',
    'line-style': isDirect ? 'solid' : (relationshipType.includes('filter') || relationshipType.includes('metadata') ? 'dotted' : 'dashed'),
    'width': isHighlighted ? '4px' : (isDirect ? '3px' : '2px'),
    'opacity': isFaded ? 0.3 : (isHighlighted ? 1.0 : 0.8),
    'z-index': isHighlighted ? 100 : 10
  };
};

// Enhanced node styling with activity-aware design and hierarchical grouping
const getNodeStyle = (nodeType, nodeSubType = null, isSelected = false, isRelated = false, isOrphan = false, isHighlighted = false, isFaded = false, isActivity = false) => {
  const baseColor = getNodeColor(nodeType);
  
  let backgroundColor = baseColor;
  let borderStyle = 'solid';
  let borderWidth = '2px';
  let opacity = 1.0;
  let borderColor = '#ffffff';
  let width = '140px';
  let height = '50px';
  let shape = 'roundrectangle';
  let fontSize = '12px';
  
  // Activity nodes styling - smaller and circular
  if (isActivity) {
    width = '80px';
    height = '30px';
    shape = 'ellipse';
    fontSize = '10px';
    backgroundColor = getActivityColor(nodeSubType);
    borderWidth = '1px';
  }
  
  if (isOrphan) {
    backgroundColor = '#f5f5f5';
    borderStyle = 'dashed';
    borderWidth = '1px';
    borderColor = '#cccccc';
    opacity = 0.6;
  } else if (isRelated) {
    backgroundColor = `${backgroundColor}80`; // 50% opacity
    borderStyle = 'dashed';
    borderWidth = '1px';
    borderColor = baseColor;
    opacity = 0.8;
  } else if (isSelected) {
    borderColor = '#ffffff';
    borderWidth = '3px';
  }
  
  if (isHighlighted) {
    borderColor = '#FFD700'; // Gold for highlighting
    borderWidth = isActivity ? '3px' : '4px';
    opacity = 1.0;
  } else if (isFaded) {
    opacity = 0.3;
  }
  
  return {
    'background-color': backgroundColor,
    'color': isOrphan ? '#666666' : '#ffffff',
    'text-valign': 'center',
    'text-halign': 'center',
    'font-size': fontSize,
    'font-weight': isSelected || isHighlighted ? 'bold' : (isRelated || isOrphan ? 'normal' : 'bold'),
    'width': width,
    'height': height,
    'shape': shape,
    'border-width': borderWidth,
    'border-color': borderColor,
    'border-style': borderStyle,
    'text-wrap': 'wrap',
    'text-max-width': isActivity ? '70px' : '120px',
    'opacity': opacity,
    'z-index': isHighlighted ? 100 : (isSelected ? 50 : (isActivity ? 30 : 10))
  };
};

// Get activity-specific colors
const getActivityColor = (activityType) => {
  const activityColors = {
    'FilterActivity': '#06B6D4',      // Cyan for filters
    'QueryActivity': '#10B981',       // Green for SQL queries
    'EmailActivity': '#EF4444',       // Red for emails
    'FileTransferActivity': '#EAB308', // Yellow for file transfers
    'DataExtractActivity': '#A16207',  // Brown for data extracts
    'WaitActivity': '#6B7280',        // Gray for wait steps
    'DecisionActivity': '#8B5CF6',    // Purple for decisions
    'default': '#94A3B8'              // Default gray
  };
  return activityColors[activityType] || activityColors.default;
};

// Node colors mapping for graph styling (consistent with OBJECT_TYPE_COLORS)
const nodeColors = OBJECT_TYPE_COLORS;

// Get type from category for consistency
const getTypeFromCategory = (category) => {
  const mapping = {
    'Data Extensions': 'DataExtension',
    'SQL Queries': 'Query',
    'Automations': 'Automation',
    'Journeys': 'Journey',
    'Triggered Sends': 'TriggeredSend',
    'Filters': 'Filter',
    'File Transfers': 'FileTransfer',
    'Data Extracts': 'DataExtract'
  };
  return mapping[category] || category;
};

// Helper: dedupe by id
const dedupeById = (arr) => {
  const map = new Map();
  for (const el of arr || []) {
    const id = el?.data?.id || el?.id;
    if (!id) continue;
    if (!map.has(id)) map.set(id, el);
  }
  return Array.from(map.values());
};

// New helper: attempt to extract a target asset name for activity/tooltips/steps
const extractTargetAsset = (nodeData = {}) => {
  const md = nodeData.metadata || {};
  const candidates = [
    md.targetName,
    md.targetDE,
    md.targetDe,
    md.deName,
    md.dataExtensionName,
    md.destinationName,
    nodeData.targetName,
    nodeData.toName,
    nodeData.deName,
    nodeData.destinationName
  ].filter(Boolean);
  if (candidates.length > 0) return candidates[0];
  if (typeof nodeData.label === 'string' && nodeData.label.includes('→')) {
    try {
      return nodeData.label.split('→').pop().trim();
    } catch (_) {
      return null;
    }
  }
  return null;
};

// Toggle category expansion
  const toggleCategory = (category) => {
    setExpandedCategories(prev => ({
      ...prev,
      [category]: !prev[category]
    }));
  };

  // Handle object selection
  const handleObjectSelect = (category, objectId, isSelected) => {
    // Set loading state for right side immediately when user makes a selection
    if (isSelected) {
      setRightSideLoading(true);
    }
    
    console.log('🎯 [Frontend] Object selection changed:', {
      category,
      objectId,
      isSelected,
      objectIdType: typeof objectId,
      objectIdValue: objectId
    });
    
    setSelectedObjects(prev => ({
      ...prev,
      [category]: {
        ...prev[category],
        [objectId]: isSelected
      }
    }));
    
    // When user makes a selection, switch to focused mode
    if (isSelected && showAllObjects) {
      console.log('🎯 [Selection] Switching to focused mode due to object selection');
      setShowAllObjects(false);
    }

    // updateGraph will be called automatically via useEffect dependency on selectedObjects
    // No need to call it manually here to avoid double execution
  };

  // Load objects data from API
  const loadObjectsData = useCallback(async () => {
    setObjectsLoading(true);
    setObjectsError(null);
    try {
      const data = await fetchObjects();
      setObjectData(data);
      console.log('✅ [Objects] Loaded from API:', Object.keys(data).map(key => `${key}: ${data[key].length}`));
    } catch (error) {
      setObjectsError(error.message);
      console.error('❌ [Objects] API Error:', error);
      // Set empty object data on error
      setObjectData({});
    } finally {
      setObjectsLoading(false);
    }
  }, []);

  // Load graph data from API
  const loadGraphData = useCallback(async () => {
    setApiLoading(true);
    setApiError(null);
    try {
      // When showAllObjects is true, pass empty selection to get all objects
      // When showAllObjects is false, pass actual selectedObjects for focused selection
      const selectionToSend = showAllObjects ? {} : selectedObjects;
      
      console.log('🔄 [Graph] Loading graph data with mode:', { 
        showAllObjects, 
        selectionToSend, 
        originalSelection: selectedObjects 
      });
      
      const data = await fetchGraphData(selectionToSend);
      console.log('✅ [Graph] Graph data loaded:', { 
        nodes: data.nodes?.length || 0, 
        edges: data.edges?.length || 0 
      });
      
      // Clear right side loading when data is received
      setRightSideLoading(false);
      
      return data;
    } catch (error) {
      console.error('❌ [Graph] Error loading graph data:', error);
      setApiError(error.message);
      setRightSideLoading(false); // Clear loading on error too
      // Return previous data instead of empty to prevent blank screen
      return { nodes: [], edges: [] };
    } finally {
      setApiLoading(false);
    }
  }, [selectedObjects, showAllObjects]);

  // Enhanced relationship classification
  const classifyRelationship = (relationshipType) => {
    const directTypes = ['writes_to', 'reads_from', 'imports_to_de', 'updates_de', 'journey_entry_source', 'filters_to', 'filters_from'];
    const indirectTypes = ['contains_query', 'executes_query', 'triggers_automation', 'executes_activity', 'next_step'];
    const metadataTypes = ['filters_de', 'uses_in_decision', 'provides_data_to'];
    
    if (directTypes.includes(relationshipType)) return 'direct';
    if (indirectTypes.includes(relationshipType)) return 'indirect';
    if (metadataTypes.includes(relationshipType)) return 'metadata';
    return 'unknown';
  };

  // Enhanced graph update with comprehensive filtering and highlighting
  const updateGraph = useCallback(async () => {
    console.log('🔧 [Graph Update] Starting enhanced graph update with selections:', selectedObjects);
    
    const baseGraphData = await loadGraphData();
    
    // Clear right side loading state when data is loaded
    setRightSideLoading(false);

    // Check if we have active selections
    const hasActiveSelections = Object.keys(selectedObjects).length > 0 && 
      Object.values(selectedObjects).some(categoryObj => 
        Object.values(categoryObj || {}).some(selected => selected)
      );

    // For focused selections, use only backend data (no merging with extraGraph)
    // For general browsing, merge in expanded data
    const mergedGraphData = hasActiveSelections ? {
      nodes: baseGraphData.nodes || [],
      edges: baseGraphData.edges || []
    } : {
      nodes: dedupeById([...(baseGraphData.nodes || []), ...(extraGraph.nodes || [])]),
      edges: dedupeById([...(baseGraphData.edges || []), ...(extraGraph.edges || [])])
    };
    
    console.log('📊 [Graph Update] Data source:', {
      backend: { nodes: baseGraphData.nodes?.length || 0, edges: baseGraphData.edges?.length || 0 },
      extraGraph: { nodes: extraGraph.nodes?.length || 0, edges: extraGraph.edges?.length || 0 },
      merged: { nodes: mergedGraphData.nodes?.length || 0, edges: mergedGraphData.edges?.length || 0 },
      usingOnlyBackend: hasActiveSelections
    });
    
    // Initialize debugging information
    const debugData = {
      totalNodes: mergedGraphData.nodes.length,
      totalEdges: mergedGraphData.edges.length,
      nodeTypes: {},
      edgeTypes: {},
      relationshipLevels: { direct: 0, indirect: 0, metadata: 0, unknown: 0 },
      orphanNodes: [],
      connectedNodes: [],
      relationships: [],
      filteredEdges: 0,
      finalStats: {}
    };
    
    // Build comprehensive relationship map
    const nodeConnections = new Map();
    const edgeMap = new Map();
    
    // Initialize connection tracking for all nodes
    mergedGraphData.nodes.forEach(node => {
      nodeConnections.set(node.data.id, {
        node: node,
        inbound: [],
        outbound: [],
        hasDirectConnections: false,
        hasIndirectConnections: false,
        hasMetadataConnections: false,
        totalConnections: 0
      });
      
      const nodeType = node.data.type || node.data.category || 'unknown';
      debugData.nodeTypes[nodeType] = (debugData.nodeTypes[nodeType] || 0) + 1;
      
      // Debug Activity nodes specifically
      if (nodeType === 'Activity' || node.data.category === 'Activity') {
        console.log(`🎯 [Activity Node Debug] Found Activity node:`, {
          id: node.data.id,
          label: node.data.label,
          category: node.data.category,
          type: node.data.type,
          activityType: node.data.metadata?.activityType,
          connectionCount: node.data.metadata?.connectionCount
        });
      }
    });
    
    // Process edges and classify relationships
    const validEdges = [];
    mergedGraphData.edges.forEach(edge => {
      const sourceConn = nodeConnections.get(edge.data.source);
      const targetConn = nodeConnections.get(edge.data.target);
      
      if (!sourceConn || !targetConn) {
        console.warn(`⚠️ [Graph] Invalid edge: ${edge.data.source} -> ${edge.data.target} (missing nodes)`);
        return;
      }
      
      // Classify relationship level
      const relationshipLevel = classifyRelationship(edge.data.type);
      debugData.relationshipLevels[relationshipLevel]++;
      
      // Create edge info object
      const edgeInfo = {
        edge: edge,
        level: relationshipLevel,
        isDirect: relationshipLevel === 'direct',
        isIndirect: relationshipLevel === 'indirect',
        isMetadata: relationshipLevel === 'metadata'
      };
      
      // Apply filtering based on user preferences
      let includeEdge = true;
      
      // Always show indirect relationships for complete view
      if (false && relationshipLevel === 'indirect') {
        includeEdge = false;
        debugData.filteredEdges++;
        console.log(`🚫 [Graph] Filtered indirect edge: ${edge.data.type} (${edge.data.source} -> ${edge.data.target})`);
      }
      
      if (includeEdge) {
        validEdges.push(edgeInfo);
        edgeMap.set(edge.data.id, edgeInfo);
        
        // Debug FilterActivity relationships specifically
        if (edge.data.source.includes('FilterActivity') || edge.data.target.includes('FilterActivity')) {
          console.log(`🎯 [FilterActivity Edge Debug] Found FilterActivity edge:`, {
            id: edge.data.id,
            source: edge.data.source,
            target: edge.data.target,
            type: edge.data.type,
            relationshipLevel: relationshipLevel,
            included: includeEdge
          });
        }
        
        // Update connection tracking
        sourceConn.outbound.push({
          edgeId: edge.data.id,
          targetId: edge.data.target,
          type: edge.data.type,
          label: edge.data.label,
          level: relationshipLevel
        });
        
        targetConn.inbound.push({
          edgeId: edge.data.id,
          sourceId: edge.data.source,
          type: edge.data.type,
          label: edge.data.label,
          level: relationshipLevel
        });
        
        // Mark connection types
        if (relationshipLevel === 'direct') {
          sourceConn.hasDirectConnections = true;
          targetConn.hasDirectConnections = true;
        } else if (relationshipLevel === 'indirect') {
          sourceConn.hasIndirectConnections = true;
          targetConn.hasIndirectConnections = true;
        } else if (relationshipLevel === 'metadata') {
          sourceConn.hasMetadataConnections = true;
          targetConn.hasMetadataConnections = true;
        }
        
        sourceConn.totalConnections++;
        targetConn.totalConnections++;
      }
      
      // Track edge types for debugging
      debugData.edgeTypes[edge.data.type] = (debugData.edgeTypes[edge.data.type] || 0) + 1;
      
      debugData.relationships.push({
        id: edge.data.id,
        source: edge.data.source,
        target: edge.data.target,
        type: edge.data.type,
        label: edge.data.label,
        level: relationshipLevel,
        included: includeEdge
      });
    });
    
    // Separate connected and orphan nodes
    const connectedNodes = [];
    const orphanNodes = [];
    
    nodeConnections.forEach((connection, nodeId) => {
      const node = connection.node;
      const nodeType = node.data.type || node.data.category || 'unknown';
      
      // Debug log for each node
      console.log(`🔍 [Node Debug] ${nodeType}: ${node.data.label}`);
      console.log(`  - ID: ${nodeId}`);
      console.log(`  - Selected: ${node.data.metadata?.isRelated !== true ? 'YES' : 'NO'}`);
      console.log(`  - Related: ${node.data.metadata?.isRelated === true ? 'YES' : 'NO'}`);
      console.log(`  - Direct connections: ${connection.hasDirectConnections ? 'YES' : 'NO'}`);
      console.log(`  - Indirect connections: ${connection.hasIndirectConnections ? 'YES' : 'NO'}`);
      console.log(`  - Metadata connections: ${connection.hasMetadataConnections ? 'YES' : 'NO'}`);
      console.log(`  - Total connections: ${connection.totalConnections}`);
      console.log(`  - Inbound: ${connection.inbound.length} [${connection.inbound.map(i => i.label).join(', ')}]`);
      console.log(`  - Outbound: ${connection.outbound.length} [${connection.outbound.map(o => o.label).join(', ')}]`);
      
      // Extra debug for Activity nodes
      if (nodeType === 'Activity' || node.data.category === 'Activity') {
        console.log(`🎯 [Activity Debug] ${nodeId}:`, {
          inboundCount: connection.inbound.length,
          outboundCount: connection.outbound.length,
          totalConnections: connection.totalConnections,
          hasAnyConnections: connection.totalConnections > 0,
          willBeIncluded: connection.totalConnections > 0
        });
      }
      
      const hasAnyConnections = connection.totalConnections > 0;
      
      if (hasAnyConnections) {
        console.log(`  ✅ Including in graph (has ${connection.totalConnections} relationships)`);
        
        // Debug FilterActivity inclusion specifically
        if (nodeType === 'Activity' || node.data.category === 'Activity') {
          console.log(`🎯 [FilterActivity Include] Activity node being included:`, {
            id: nodeId,
            label: node.data.label,
            activityType: node.data.activityType,
            connections: connection.totalConnections,
            inbound: connection.inbound.map(i => i.type),
            outbound: connection.outbound.map(o => o.type)
          });
        }
        
        connectedNodes.push(node);
        debugData.connectedNodes.push({
          id: nodeId,
          label: node.data.label,
          type: nodeType,
          inboundCount: connection.inbound.length,
          outboundCount: connection.outbound.length,
          directConnections: connection.hasDirectConnections,
          indirectConnections: connection.hasIndirectConnections,
          metadataConnections: connection.hasMetadataConnections,
          isSelected: node.data.metadata?.isRelated !== true,
          relationships: [...connection.inbound, ...connection.outbound]
        });
      } else {
        console.log(`  ❌ Node has no relationships`);
        orphanNodes.push(node);
        debugData.orphanNodes.push({
          id: nodeId,
          label: node.data.label,
          type: nodeType,
          reason: 'No inbound or outbound relationships found'
        });
      }
    });
    
    // Filter nodes based on user preferences
    let finalNodes = connectedNodes;
    
    // Always show orphan nodes for better visibility
    if (true) {
      // Include orphan nodes with special styling
      const styledOrphanNodes = orphanNodes.map(node => ({
        ...node,
        data: {
          ...node.data,
          metadata: {
            ...node.data.metadata,
            isOrphan: true
          }
        }
      }));
      finalNodes = [...connectedNodes, ...styledOrphanNodes];
      console.log(`🔘 [Graph Filter] Including ${orphanNodes.length} orphan nodes`);
    } else {
      console.log(`❌ [Graph Filter] Excluding ${orphanNodes.length} orphan nodes`);
    }

    // Apply node highlighting based on selection
    const highlightedNodes = new Set();
    const highlightedEdges = new Set();
    
    if (selectedNodeId) {
      highlightedNodes.add(selectedNodeId);
      
      // Find all connected nodes and edges
      const selectedConnection = nodeConnections.get(selectedNodeId);
      if (selectedConnection) {
        selectedConnection.inbound.forEach(conn => {
          highlightedNodes.add(conn.sourceId);
          highlightedEdges.add(conn.edgeId);
        });
        selectedConnection.outbound.forEach(conn => {
          highlightedNodes.add(conn.targetId);
          highlightedEdges.add(conn.edgeId);
        });
      }
    }
    
    console.log(`📋 [Graph Summary] Final node counts:`, {
      connectedNodes: connectedNodes.length,
      orphanNodes: orphanNodes.length,
      finalNodes: finalNodes.length,
      activityNodesInFinal: finalNodes.filter(n => n.data.category === 'Activity' || n.data.type === 'Activity').length
    });
    
    // Apply enhanced styling to nodes with vertical grouping by type (including activities)
    const styledNodes = finalNodes.map((node, index) => {
      const isSelected = node.data.metadata?.isRelated !== true;
      const isRelated = node.data.metadata?.isRelated === true;
      const isOrphan = node.data.metadata?.isOrphan === true;
      const isHighlighted = highlightedNodes.has(node.data.id);
      const isFaded = selectedNodeId && !highlightedNodes.has(node.data.id);
      const isActivity = node.data.category === 'Activity' || node.data.metadata?.isActivity === true;
      const activityType = node.data.activityType;
      const stepNumber = node.data.stepNumber;
      const nodeType = node.data.type || node.data.category || 'default';
      
      // Calculate vertical position based on node type for hierarchical grouping
      const typeOrder = {
        'Automations': 0,      // Top level - orchestrators
        'Activity': 1,         // Middle level - activities within automations
        'SQL Queries': 2,      // Asset level
        'Data Extensions': 3,  // Asset level
        'Filters': 4,          // Asset level
        'Journeys': 5,         // Asset level
        'Triggered Sends': 6,  // Asset level
        'File Transfers': 7,   // Asset level
        'Data Extracts': 8     // Asset level
      };
      
      const typeIndex = typeOrder[nodeType] || 9;
      let baseY = typeIndex * 180; // Vertical spacing between types
      
      // For activities, further sub-group by parent automation and step number
      if (isActivity && stepNumber) {
        // Simple hash function for automation grouping
        const hashCode = (str) => {
          let hash = 0;
          for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
          }
          return Math.abs(hash);
        };
        
        const automationIndex = node.data.metadata?.automationId ? 
          hashCode(node.data.metadata.automationId) % 5 : 0; // Simple hash for automation grouping
        baseY += (automationIndex * 40) + (stepNumber * 15); // Sub-grouping within activity layer
      }
      
      // Create activity-aware label
      let displayLabel = node.data.label;
      if (isActivity && stepNumber) {
        displayLabel = `${stepNumber}. ${activityType.replace('Activity', '')}`;
        if (node.data.label && !node.data.label.startsWith(stepNumber)) {
          displayLabel += `\n${node.data.label}`;
        }
      }
      
      return {
        ...node,
        data: {
          ...node.data,
          label: displayLabel
        },
        position: {
          x: (index % 6) * 180 + Math.random() * 40, // Horizontal spread with some randomness
          y: baseY + Math.random() * 60 // Vertical grouping with some randomness
        },
        style: getNodeStyle(nodeType, activityType, isSelected, isRelated, isOrphan, isHighlighted, isFaded, isActivity)
      };
    });

    // Apply enhanced styling to edges (including activity flow edges)
    const styledEdges = validEdges.map(edgeInfo => {
      const edge = edgeInfo.edge;
      const isHighlighted = highlightedEdges.has(edge.data.id);
      const isFaded = selectedNodeId && !highlightedEdges.has(edge.data.id);
      const isActivityFlow = edge.data.type === 'executes_activity' || edge.data.type === 'next_step';
      const stepNumber = edge.data.stepNumber;

      // Determine relation style from backend when available
      const relationStyle = edge.data.relationStyle || (edgeInfo.isDirect ? 'direct' : (edgeInfo.isIndirect ? 'workflow' : (edgeInfo.isMetadata ? 'metadata' : 'unknown')));
      const isDirectForStyle = relationStyle === 'direct';
      const relationshipTypeForStyle = relationStyle === 'metadata' ? 'metadata' : edge.data.type;
      
      // Create enhanced label for activity flows
      let edgeLabel = edge.data.label;
      if (isActivityFlow && stepNumber) {
        edgeLabel = edge.data.type === 'next_step' ? `${stepNumber} →` : `Step ${stepNumber}`;
      }
      
      return {
        ...edge,
        data: {
          ...edge.data,
          label: edgeLabel
        },
        style: {
          ...getEdgeStyle(relationshipTypeForStyle, isDirectForStyle, isHighlighted, isFaded),
          'label': edgeLabel,
          'font-size': isHighlighted ? '11px' : (isActivityFlow ? '9px' : '10px'),
          'font-weight': isActivityFlow ? '700' : '600',
          'text-rotation': isActivityFlow ? '0deg' : 'autorotate', // Keep step labels horizontal
          'text-background-color': isActivityFlow ? '#FEF3C7' : '#ffffff',
          'text-background-opacity': isHighlighted ? 0.95 : 0.9,
          'text-background-padding': isActivityFlow ? '4px' : '3px',
          'text-border-color': getEdgeStyle(relationshipTypeForStyle, isDirectForStyle)['line-color'],
          'text-border-width': '1px',
          'text-border-opacity': 0.3,
          'width': isActivityFlow ? 3 : 2, // Thicker lines for activity flows
          'target-arrow-shape': isActivityFlow ? 'triangle' : 'triangle',
          'target-arrow-size': isActivityFlow ? '8px' : '6px'
        }
      };
    });

    // Update debug information
    debugData.finalStats = {
      finalNodes: finalNodes.length,
      connectedNodes: connectedNodes.length,
      orphanNodes: orphanNodes.length,
      validEdges: validEdges.length,
      filteredEdges: debugData.filteredEdges,
      highlightedNodes: highlightedNodes.size,
      highlightedEdges: highlightedEdges.size,
      showOrphans: true, // always true
      showIndirect: true, // always true
      selectedNodeId
    };
    
    setDebugInfo(debugData);
    setRelationshipStats({
      totalObjects: mergedGraphData.nodes.length,
      connectedObjects: connectedNodes.length,
      orphanObjects: orphanNodes.length,
      totalRelationships: mergedGraphData.edges.length,
      displayedRelationships: validEdges.length,
      filteredRelationships: debugData.filteredEdges,
      directRelationships: debugData.relationshipLevels.direct,
      indirectRelationships: debugData.relationshipLevels.indirect,
      metadataRelationships: debugData.relationshipLevels.metadata,
      showingOrphans: true, // always show orphans
      showingIndirect: true // always show indirect
    });

    console.log('📊 [Graph Final] Final graph stats:', debugData.finalStats);
    
    // Debug final styled nodes for Activity nodes
    const activityNodes = styledNodes.filter(n => n.data.category === 'Activity' || n.data.type === 'Activity');
    console.log(`🎯 [Final Styled Nodes] Found ${activityNodes.length} Activity nodes:`, activityNodes.map(n => ({
      id: n.data.id,
      label: n.data.label,
      type: n.data.type,
      category: n.data.category,
      activityType: n.data.activityType
    })));

    setGraphElements([...styledNodes, ...styledEdges]);
    setHighlightedElements(new Set([...highlightedNodes, ...highlightedEdges]));
  }, [selectedObjects, loadGraphData, selectedNodeId, extraGraph, showAllObjects]); // eslint-disable-line react-hooks/exhaustive-deps

  // Enhanced node click handler with automation steps tracking
  const handleNodeClick = useCallback(async (event) => {
    const node = event.target;
    const nodeData = node.data();
    
    // Toggle highlighting
    if (selectedNodeId === nodeData.id) {
      setSelectedNodeId(null);
      setSelectedNode(null);
      setDrawerOpen(false);
      setAutomationSteps([]); // Clear automation steps
    } else {
      setSelectedNodeId(nodeData.id);
      
      // Extract automation steps if this is an automation node
      if (nodeData.category === 'Automations' || nodeData.type === 'Automation') {
        const activityNodes = graphElements.filter(el => 
          el.data && 
          el.data.category === 'Activity' && 
          el.data.metadata?.automationId === nodeData.id
        );
        
        const steps = activityNodes
          .map(activityNode => ({
            stepNumber: activityNode.data.stepNumber || 0,
            activityType: activityNode.data.activityType || 'Unknown',
            activityId: activityNode.data.id,
            name: activityNode.data.label,
            targetAsset: extractTargetAsset(activityNode.data),
            automationId: nodeData.id
          }))
          .sort((a, b) => a.stepNumber - b.stepNumber);
        
        setAutomationSteps(steps);
        console.log(`📋 [Steps] Extracted ${steps.length} steps for automation "${nodeData.label}":`, steps);
      } else {
        setAutomationSteps([]);
      }
      
      // Fetch detailed node information from API
      try {
        const nodeDetails = await fetchNodeDetails(nodeData.id);
        setSelectedNode({
          ...nodeData,
          apiDetails: nodeDetails
        });
      } catch (error) {
        console.error('Error fetching node details:', error);
        // Fall back to basic node data
        setSelectedNode(nodeData);
      }
      
      setDrawerOpen(true);
    }
  }, [selectedNodeId, graphElements]);

  // Card selection handler (for SchemaCardBoard)
  const handleCardSelect = useCallback(async (nodeData) => {
    // Toggle highlighting
    if (selectedNodeId === nodeData.id) {
      setSelectedNodeId(null);
      setSelectedNode(null);
      setDrawerOpen(false);
      setAutomationSteps([]);
      return;
    }
    setSelectedNodeId(nodeData.id);

    // Extract automation steps if this is an automation node (derive from available elements)
    if (nodeData.category === 'Automations' || nodeData.type === 'Automation') {
      const activityNodes = graphElements.filter(el => 
        el.data && 
        el.data.category === 'Activity' && 
        el.data.metadata?.automationId === nodeData.id
      );
      const steps = activityNodes
        .map(activityNode => ({
          stepNumber: activityNode.data.stepNumber || 0,
          activityType: activityNode.data.activityType || 'Unknown',
          activityId: activityNode.data.id,
          name: activityNode.data.label,
          targetAsset: extractTargetAsset(activityNode.data),
          automationId: nodeData.id
        }))
        .sort((a, b) => a.stepNumber - b.stepNumber);
      setAutomationSteps(steps);
    } else {
      setAutomationSteps([]);
    }

    try {
      const nodeDetails = await fetchNodeDetails(nodeData.id);
      setSelectedNode({
        ...nodeData,
        apiDetails: nodeDetails
      });
    } catch (e) {
      setSelectedNode(nodeData);
    }
    setDrawerOpen(true);
  }, [selectedNodeId, graphElements, extractTargetAsset]);

  // New: expand a selected node's dependencies (1-hop)
  const expandSelectedNode = useCallback(async () => {
    if (!selectedNodeId) return;
    try {
      setIsExpanding(true);
      const data = await fetchExpandDependencies(selectedNodeId);
      const newNodes = dedupeById([...(data.nodes || [])]);
      const newEdges = dedupeById([...(data.edges || [])]);

      setExtraGraph(prev => ({
        nodes: dedupeById([...(prev.nodes || []), ...newNodes]),
        edges: dedupeById([...(prev.edges || []), ...newEdges])
      }));

      console.log(`🧩 [Expand] Added ${newNodes.length} nodes and ${newEdges.length} edges for ${selectedNodeId}`);

      // Rebuild graph with expansions
      await updateGraph();
    } catch (e) {
      console.error('❌ [Expand] Failed to expand dependencies:', e);
    } finally {
      setIsExpanding(false);
    }
  }, [selectedNodeId, updateGraph]);

  // New: recursively expand dependencies up to a depth
  const expandSelectedNodeRecursively = useCallback(async (maxDepth = 3) => {
    if (!selectedNodeId) return;
    setIsExpanding(true);
    try {
      const visited = new Set((extraGraph.nodes || []).map(n => n?.data?.id).filter(Boolean));
      let frontier = [selectedNodeId];
      let depth = 0;
      while (frontier.length && depth < maxDepth) {
        const nextFrontier = new Set();
        await Promise.all(frontier.map(async (nodeId) => {
          try {
            const res = await fetchExpandDependencies(nodeId);
            const nodes = res.nodes || [];
            const edges = res.edges || [];

            setExtraGraph(prev => ({
              nodes: dedupeById([...(prev.nodes || []), ...nodes]),
              edges: dedupeById([...(prev.edges || []), ...edges])
            }));

            nodes.forEach(n => {
              const id = n?.data?.id;
              if (id && !visited.has(id)) {
                visited.add(id);
                nextFrontier.add(id);
              }
            });
          } catch (err) {
            console.warn('⚠️ [Expand-All] Failed expanding node', nodeId, err);
          }
        }));
        frontier = Array.from(nextFrontier);
        depth += 1;
      }
      await updateGraph();
      console.log(`✅ [Expand-All] Finished recursive expansion up to depth ${depth}`);
    } catch (err) {
      console.error('❌ [Expand-All] Error:', err);
    } finally {
      setIsExpanding(false);
    }
  }, [selectedNodeId, extraGraph, updateGraph]);

  // New: reset expansions
  const resetExpansions = useCallback(async () => {
    setExtraGraph({ nodes: [], edges: [] });
    await updateGraph();
  }, [updateGraph]);

  // Function to highlight automation step
  const highlightAutomationStep = useCallback((step) => {
    if (step.activityId) {
      setSelectedNodeId(step.activityId);
      console.log(`🎯 [Highlight] Highlighting activity step: ${step.stepNumber} - ${step.activityType}`);
    }
  }, []);

  // Cytoscape layout and style
  const cytoscapeStylesheet = [
    {
      selector: 'node',
      style: {
        'width': 120,
        'height': 40,
        'shape': 'roundrectangle',
        'background-color': '#6B7280',
        'label': 'data(label)',
        'color': '#ffffff',
        'text-valign': 'center',
        'text-halign': 'center',
        'font-size': '12px',
        'font-weight': 'bold',
        'text-wrap': 'wrap',
        'text-max-width': '100px'
      }
    },
    {
      selector: 'edge',
      style: {
        'width': 2,
        'line-color': '#94A3B8',
        'target-arrow-color': '#94A3B8',
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        'label': 'data(label)',
        'font-size': '10px',
        'text-rotation': 'autorotate',
        'text-background-color': '#ffffff',
        'text-background-opacity': 0.8,
        'text-background-padding': '2px'
      }
    }
  ];

  // Enhanced Cytoscape layout with vertical grouping
  const layout = {
    name: 'preset', // Use preset positions for vertical grouping
    animate: true,
    animationDuration: 1000,
    animationEasing: 'ease-out',
    fit: true,
    padding: 50
  };

  // Fallback layout for when preset positions are not available
  const fallbackLayout = {
    name: 'cose',
    animate: true,
    animationDuration: 1000,
    animationEasing: 'ease-out',
    nodeDimensionsIncludeLabels: true,
    fit: true,
    padding: 50,
    componentSpacing: 150,
    nodeOverlap: 30,
    idealEdgeLength: 120,
    edgeElasticity: 200,
    nestingFactor: 12,
    gravity: 80,
    numIter: 1000,
    initialTemp: 200,
    coolingFactor: 0.95,
    minTemp: 1.0,
    nodeRepulsion: function(node) { return 400000; }
  };

  useEffect(() => {
    // Only update graph if we have active selections OR user explicitly wants to see all
    const hasActiveSelections = Object.keys(selectedObjects).length > 0 && 
      Object.values(selectedObjects).some(categoryObj => 
        Object.values(categoryObj || {}).some(selected => selected)
      );
    
    if (hasActiveSelections || showAllObjects) {
      console.log('🔧 [Graph Effect] Triggering updateGraph:', { hasActiveSelections, showAllObjects, selectedObjects });
      updateGraph();
    } else {
      console.log('🔧 [Graph Effect] Skipping updateGraph - no active selections and showAllObjects=false');
      // Clear the graph when no selections and not showing all
      setGraphElements([]);
    }
  }, [selectedObjects, updateGraph, showAllObjects]);

  // Load objects on mount
  useEffect(() => {
    loadObjectsData();
  }, [loadObjectsData]);

  useEffect(() => {
    if (cyRef.current) {
      // Add all event listeners
      cyRef.current.on('tap', 'node', handleNodeClick);
      
      // Add hover events for tooltips
      cyRef.current.on('mouseover', 'node', (event) => {
        const node = event.target;
        const nodeData = node.data();
        
        // Create tooltip content based on node type
        let tooltipContent = '';
        if (nodeData.category === 'Activity') {
          const stepNum = nodeData.stepNumber ? `Step ${nodeData.stepNumber}: ` : '';
          const activityType = nodeData.activityType || 'Activity';
          const targetAsset = extractTargetAsset(nodeData);
          tooltipContent = `${stepNum}${activityType}${targetAsset ? ` → ${targetAsset}` : ''}`;
        } else {
          tooltipContent = `${nodeData.type || nodeData.category}: ${nodeData.label}`;
          if (nodeData.metadata?.connectionCount > 0) {
            tooltipContent += ` (${nodeData.metadata.connectionCount} connections)`;
          }
        }
        
        // Set title attribute for browser tooltip
        node.style('label', tooltipContent);
        setHoveredNodeId(nodeData.id);
      });
      
      cyRef.current.on('mouseout', 'node', (event) => {
        const node = event.target;
        const nodeData = node.data();
        
        // Restore original label
        node.style('label', nodeData.label);
        setHoveredNodeId(null);
      });
      
      return () => {
        if (cyRef.current) {
          cyRef.current.removeListener('tap', 'node', handleNodeClick);
          cyRef.current.removeListener('mouseover', 'node');
          cyRef.current.removeListener('mouseout', 'node');
        }
      };
    }
  }, [handleNodeClick, extractTargetAsset]);

  // Separate nodes and edges for card board rendering
  const boardNodes = graphElements.filter(el => el?.data && !(el.data.source && el.data.target));
  const boardEdges = graphElements.filter(el => el?.data && (el.data.source && el.data.target));

  // Debug: log what's being passed to the card board
  console.log('🎨 [CardBoard] Data being rendered:', {
    totalGraphElements: graphElements.length,
    boardNodes: boardNodes.length,
    boardEdges: boardEdges.length,
    selectedObjects: selectedObjects,
    nodeIds: boardNodes.map(n => ({ id: n.data?.id, name: n.data?.label, type: n.data?.type }))
  });

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Left Sidebar */}
      <div className="w-80 bg-white border-r border-gray-200 overflow-y-auto">
        <div className="p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Schema Objects</h2>
          <p className="text-sm text-gray-600">Select objects to visualize relationships</p>
          
          {/* View Mode Toggle */}
          <div className="mt-3 flex items-center space-x-2">
            <div className="inline-flex rounded-md shadow-sm" role="group">
              <button
                type="button"
                className={`px-3 py-1.5 text-xs font-medium border ${viewMode === 'cards' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`}
                onClick={() => setViewMode('cards')}
              >
                Cards
              </button>
              <button
                type="button"
                className={`px-3 py-1.5 text-xs font-medium border -ml-px ${viewMode === 'graph' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`}
                onClick={() => setViewMode('graph')}
              >
                Graph
              </button>
            </div>
            
            {/* Show All Button */}
            <button
              type="button"
              className={`px-3 py-1.5 text-xs font-medium border rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 ${showAllObjects ? 'bg-indigo-600 text-white border-indigo-600' : 'text-gray-700 bg-white border-gray-300 hover:bg-gray-50'}`}
              onClick={() => {
                console.log('🔄 [Show All] Toggling show all objects');
                setShowAllObjects(prev => !prev);
                if (!showAllObjects) {
                  // When turning on "Show All", clear any focused selections
                  setSelectedObjects({});
                }
              }}
              title={showAllObjects ? "Switch to focused selection mode" : "Show all objects (no focused selection)"}
            >
              {showAllObjects ? "Focused" : "Show All"}
            </button>
          </div>
          
          {/* Search Bar */}
          <div className="mt-3 relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <svg className="h-4 w-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <input
              type="text"
              placeholder="Search objects..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md leading-5 bg-white placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-blue-500 focus:border-blue-500 text-sm"
            />
            {searchTerm && (
              <div className="absolute inset-y-0 right-0 pr-3 flex items-center">
                <button
                  onClick={() => setSearchTerm('')}
                  className="text-gray-400 hover:text-gray-600 focus:outline-none"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}
          </div>
          
          {/* Search Results Summary */}
          {searchTerm && (
            <div className="mt-2 text-xs text-gray-500">
              {Object.keys(filteredObjectData).length === 0 ? (
                <span>No objects match "{searchTerm}"</span>
              ) : (
                <span>
                  {Object.values(filteredObjectData).reduce((sum, objects) => sum + objects.length, 0)} objects 
                  in {Object.keys(filteredObjectData).length} categories match "{searchTerm}"
                </span>
              )}
            </div>
          )}
          
          {/* API Status */}
          <div className="mt-3">
            {(apiLoading || objectsLoading) && (
              <div className="flex items-center text-xs text-blue-600">
                <svg className="animate-spin -ml-1 mr-2 h-3 w-3" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 008-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                {objectsLoading ? 'Loading objects...' : 'Loading from API...'}
              </div>
            )}
            {(apiError || objectsError) && (
              <div className="text-xs text-red-600 flex items-center">
                <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                API Error: {apiError || objectsError}
              </div>
            )}
            {!apiLoading && !apiError && !objectsLoading && !objectsError && (
              <div className="text-xs text-green-600 flex items-center">
                <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Connected to SFMC API
              </div>
            )}
          </div>
          
          {/* Enhanced Relationship Stats */}
          {Object.keys(relationshipStats).length > 0 && (
            <div className="mt-3 p-2 bg-white rounded border text-xs">
              <div className="font-semibold text-gray-700 mb-1">Graph Statistics</div>
              <div className="space-y-1 text-gray-600">
                <div>Total Objects: {relationshipStats.totalObjects}</div>
                <div>Connected: {relationshipStats.connectedObjects}</div>
                <div>Orphans: {relationshipStats.orphanObjects}</div>
                <div>Total Relationships: {relationshipStats.totalRelationships}</div>
                <div>Displayed: {relationshipStats.displayedRelationships}</div>
                {relationshipStats.filteredRelationships > 0 && (
                  <div className="text-orange-600">Filtered: {relationshipStats.filteredRelationships}</div>
                )}
                <div className="pt-1 border-t">
                  <div>Direct: {relationshipStats.directRelationships || 0}</div>
                  <div>Indirect: {relationshipStats.indirectRelationships || 0}</div>
                  <div>Metadata: {relationshipStats.metadataRelationships || 0}</div>
                </div>
                {relationshipStats.showingOrphans && (
                  <div className="text-orange-600">Including orphan nodes</div>
                )}
                {relationshipStats.showingIndirect && (
                  <div className="text-blue-600">Including indirect links</div>
                )}
              </div>
            </div>
          )}
          
          {/* Node Interaction Help */}
          <div className="mt-3 p-2 bg-blue-50 rounded text-xs">
            <div className="font-semibold text-blue-900 mb-1">Interaction Guide</div>
            <div className="text-blue-700 space-y-1">
              <div>• Click node to highlight connections</div>
              <div>• Click again to deselect</div>
              <div>• Solid lines = direct data flow</div>
              <div>• Dashed lines = indirect/workflow</div>
              <div>• Dotted lines = metadata/filters</div>
            </div>
          </div>
        </div>
        
        <div className="p-4 space-y-2">
          {objectTypes.map(category => (
            <div key={category} className="border border-gray-200 rounded-lg">
              <button
                onClick={() => toggleCategory(category)}
                className="w-full px-4 py-3 text-left flex items-center justify-between hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center space-x-3">
                  <div 
                    className="w-4 h-4 rounded-full flex-shrink-0"
                    style={{ backgroundColor: getObjectTypeColor(category) }}
                  ></div>
                  <span className="font-medium text-gray-900">{category}</span>
                </div>
                <svg
                  className={`w-5 h-5 transform transition-transform ${
                    expandedCategories[category] ? 'rotate-180' : ''
                  }`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              
              {expandedCategories[category] && (
                <div className="px-4 pb-4 space-y-2">
                  {filteredObjectData[category].map(object => (
                    <label key={object.id} className="flex items-center space-x-3 py-2 hover:bg-gray-50 rounded cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedObjects[category]?.[object.id] || false}
                        onChange={(e) => handleObjectSelect(category, object.id, e.target.checked)}
                        className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                      />
                      <div 
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: getObjectTypeColor(category) }}
                      ></div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate">
                          {object.name}
                                               </div>
                        {object.externalKey && (
                          <div className="text-xs text-gray-500 truncate">
                            {object.externalKey}
                          </div>
                        )}
                        {object.description && (
                          <div className="text-xs text-gray-500 truncate">
                            {object.description}
                          </div>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Center Canvas / Board */}
      <div className="flex-1 relative">
        <div className="absolute inset-0">
          {hasSelectedObjects ? (
            viewMode === 'graph' ? (
              <CytoscapeComponent
                elements={graphElements}
                style={{ width: '100%', height: '100%' }}
                stylesheet={cytoscapeStylesheet}
                layout={layout}
                cy={(cy) => { cyRef.current = cy; }}
                boxSelectionEnabled={false}
                autounselectify={false}
              />
            ) : apiLoading ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-center max-w-md mx-auto p-8">
                  <div className="flex items-center justify-center mb-4">
                    <svg className="animate-spin -ml-1 mr-3 h-8 w-8 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span className="text-lg font-medium text-gray-900">Loading...</span>
                  </div>
                  <p className="text-gray-600 mb-4">
                    Generating relationship graph for your selected objects...
                  </p>
                  <div className="text-sm text-gray-500">
                    <p>• Analyzing object dependencies</p>
                    <p>• Mapping data flows and connections</p>
                    <p>• Preparing visualization</p>
                  </div>
                </div>
              </div>
            ) : boardNodes.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-center max-w-md mx-auto p-8">
                  <div className="text-gray-400 mb-4">
                    📭
                  </div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">No Objects Found</h3>
                  <p className="text-gray-600 mb-4">
                    The selected objects don't have any relationships or data to display.
                  </p>
                  <div className="text-sm text-gray-500 space-y-1">
                    <p>• Check if the objects exist in Marketing Cloud</p>
                    <p>• Verify that relationships can be detected</p>
                    <p>• Try selecting different objects</p>
                  </div>
                  {apiError && (
                    <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
                      Error: {apiError}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-col h-full relative">
                {/* Loading overlay for right side */}
                {rightSideLoading && (
                  <div className="absolute inset-0 bg-white/80 backdrop-blur-sm z-50 flex items-center justify-center">
                    <div className="text-center">
                      <svg className="animate-spin -ml-1 mr-3 h-8 w-8 text-blue-600 mx-auto mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      <p className="text-sm font-medium text-blue-900">Loading relationships...</p>
                      <p className="text-xs text-blue-700 mt-1">Analyzing connections and dependencies</p>
                    </div>
                  </div>
                )}
                
                {/* Card Board Header */}
                <div className="bg-blue-50 border-b border-blue-200 px-4 py-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-medium text-blue-900">
                        Card View - Filtered Results
                      </h3>
                      <p className="text-xs text-blue-700">
                        Showing {boardNodes.length} objects, {boardEdges.length} relationships
                      </p>
                    </div>
                    <div className="text-xs text-blue-600 bg-blue-100 px-2 py-1 rounded">
                      Backend Filtered Data Only
                    </div>
                  </div>
                </div>
                {/* Card Board Component */}
                <div className="flex-1">
                  <SchemaCardBoard
                    nodes={boardNodes}
                    edges={boardEdges}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={handleCardSelect}
                    onExpandNode={() => expandSelectedNode()}
                    getTypeColor={getNodeColor}
                    fetchDetails={fetchNodeDetails}
                  />
                </div>
              </div>
            )
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="text-center max-w-md mx-auto">
                <svg className="w-20 h-20 mx-auto text-gray-400 mb-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                <h3 className="text-xl font-semibold text-gray-900 mb-3">Welcome to Schema Builder</h3>
                <p className="text-gray-600 mb-4">
                  Visualize relationships between your Salesforce Marketing Cloud assets
                </p>
                
                {!showAllObjects ? (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
                    <p className="text-sm text-blue-800 mb-2 font-medium">📍 Focused Selection Mode</p>
                    <p className="text-sm text-blue-700">
                      Select one or more objects from the sidebar to see their relationships, 
                      or click <strong>"Show All"</strong> to browse all objects.
                    </p>
                  </div>
                ) : (
                  <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-4">
                    <p className="text-sm text-gray-700">
                      Loading all objects...
                    </p>
                  </div>
                )}
                
                <div className="text-sm text-gray-500 space-y-2">
                  <p className="flex items-center justify-center space-x-2">
                    <span className="w-2 h-2 bg-blue-500 rounded-full"></span>
                    <span>🟦 Data Extensions are the foundation of your data flow</span>
                  </p>
                  <p className="flex items-center justify-center space-x-2">
                    <span className="w-2 h-2 bg-green-500 rounded-full"></span>
                    <span>🟩 SQL Queries read from and write to Data Extensions</span>
                  </p>
                  <p className="flex items-center justify-center space-x-2">
                    <span className="w-2 h-2 bg-purple-500 rounded-full"></span>
                    <span>🟪 Journeys use Data Extensions for entry and decisions</span>
                  </p>
                  <p className="flex items-center justify-center space-x-2">
                    <span className="w-2 h-2 bg-orange-500 rounded-full"></span>
                    <span>🟧 Automations orchestrate data flows and activities</span>
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
        
        {/* Debug Panel removed as per requirements */}
        
        {/* Enhanced Activity-Aware Relationship Legend */}
        {hasSelectedObjects && viewMode === 'graph' && (
          <div className="absolute bottom-4 left-4 bg-white border border-gray-300 rounded-lg shadow-lg p-3 z-10 max-w-xs">
            <h5 className="text-xs font-semibold text-gray-700 mb-2">Activity-Aware Relationships</h5>
            <div className="space-y-1 text-xs">
              <div className="flex items-center space-x-2">
                <div className="w-6 h-0.5 bg-orange-500" style={{borderBottom: '2px solid #F59E0B'}}></div>
                <span>Automation → Activity (execution)</span>
              </div>
              <div className="flex items-center space-x-2">
                <div className="w-6 h-0.5 bg-orange-400" style={{borderBottom: '1px solid #FB923C'}}></div>
                <span>Activity → Activity (next step)</span>
              </div>
              <div className="flex items-center space-x-2">
                <div className="w-6 h-0.5 bg-green-500"></div>
                <span>Activity → Asset (writes/creates)</span>
              </div>
              <div className="flex items-center space-x-2">
                <div className="w-6 h-0.5 bg-blue-500"></div>
                <span>Asset → Activity (reads/filters)</span>
              </div>
              <div className="flex items-center space-x-2">
                <div className="w-6 h-0.5 bg-cyan-500" style={{borderTop: '0.5px dotted #06B6D4'}}></div>
                <span>Metadata/Configuration</span>
              </div>
              
              <div className="pt-1 mt-2 border-t border-gray-200">
                <div className="font-medium text-gray-600 mb-1">Node Types:</div>
                <div className="flex items-center space-x-1 mb-1">
                  <div className="w-3 h-3 bg-orange-500 rounded-sm"></div>
                  <span>Automations</span>
                </div>
                <div className="flex items-center space-x-1 mb-1">
                  <div className="w-3 h-3 bg-gray-500 rounded-full"></div>
                  <span>Activities (steps)</span>
                </div>
                <div className="flex items-center space-x-1">
                  <div className="w-3 h-3 bg-blue-500 rounded-sm"></div>
                  <span>Assets (DEs, Emails, etc.)</span>
                </div>
              </div>
              
              {selectedNodeId && (
                <div className="pt-1 border-t text-yellow-700">
                  <div>🟡 Highlighting connections for selected node</div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Right Detail Drawer */}
      <div className={`fixed inset-y-0 right-0 z-50 w-96 bg-white shadow-xl transform transition-transform duration-300 ease-in-out ${
        drawerOpen ? 'translate-x-0' : 'translate-x-full'
      }`}>
        <div className="flex flex-col h-full">
          <div className="flex items-center justify-between p-4 border-b border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900">Object Details</h3>
            <button
              onClick={() => setDrawerOpen(false)}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          
          {selectedNode && (
            <div className="flex-1 overflow-y-auto p-4 space-y-6">
              <div>
                <h4 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-2">Basic Information</h4>
                <div className="space-y-3">
                  <div>
                    <label className="text-sm font-medium text-gray-700">Name</label>
                    <p className="text-sm text-gray-900">{selectedNode.label}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-700">Type</label>
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium"
                          style={{ backgroundColor: `${nodeColors[selectedNode.type]}20`, color: nodeColors[selectedNode.type] }}>
                      {selectedNode.type}
                    </span>
                  </div>
                  {selectedNode.metadata?.externalKey && (
                    <div>
                      <label className="text-sm font-medium text-gray-700">External Key</label>
                      <p className="text-sm text-gray-900 font-mono">{selectedNode.metadata.externalKey}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Dependencies and usage details using enriched API data */}
              {selectedNode.apiDetails && (
                <div className="space-y-6">
                  {/* Resolved Targets for activities or steps */}
                  {Array.isArray(selectedNode.apiDetails.resolvedTargets) && selectedNode.apiDetails.resolvedTargets.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-2">Resolved Targets</h4>
                      <ul className="space-y-1">
                        {selectedNode.apiDetails.resolvedTargets.map((t, idx) => (
                          <li key={idx} className="text-sm text-gray-800 flex items-start">
                            <span className="mt-1 mr-2 w-2 h-2 rounded-full" style={{ backgroundColor: getNodeColor(t?.type || t?.category || 'default') }}></span>
                            <div>
                              <div className="font-medium">{t?.name || t?.label || t?.id}</div>
                              {t?.type && <div className="text-xs text-gray-500">{t.type}</div>}
                              {t?.metadata?.reason && <div className="text-xs text-gray-500">{t.metadata.reason}</div>}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Inbound/Outbound Relationships */}
                  {(Array.isArray(selectedNode.apiDetails.inbound) || Array.isArray(selectedNode.apiDetails.outbound)) && (
                    <div>
                      <h4 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-2">Relationships</h4>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="p-2 bg-gray-50 rounded border">
                          <div className="text-xs font-semibold text-gray-600">Inbound</div>
                          <ul className="mt-1 space-y-1 max-h-28 overflow-y-auto">
                            {(selectedNode.apiDetails.inbound || []).map((r, idx) => (
                              <li key={idx} className="text-xs text-gray-700 truncate">{r.type}: {r.fromName || r.sourceName || r.sourceId || r.fromId}</li>
                            ))}
                          </ul>
                        </div>
                        <div className="p-2 bg-gray-50 rounded border">
                          <div className="text-xs font-semibold text-gray-600">Outbound</div>
                          <ul className="mt-1 space-y-1 max-h-28 overflow-y-auto">
                            {(selectedNode.apiDetails.outbound || []).map((r, idx) => (
                              <li key={idx} className="text-xs text-gray-700 truncate">{r.type}: {r.toName || r.targetName || r.targetId || r.toId}</li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* DE Usage Summary */}
                  {selectedNode.type === 'DataExtension' && selectedNode.apiDetails.deUsage && (
                    <div>
                      <h4 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-2">Data Extension Usage</h4>
                      <div className="space-y-2 text-sm text-gray-800">
                        {selectedNode.apiDetails.deUsage.automations && selectedNode.apiDetails.deUsage.automations.length > 0 && (
                          <div>
                            <div className="text-xs font-semibold text-gray-600">Automations</div>
                            <ul className="list-disc ml-5">
                              {selectedNode.apiDetails.deUsage.automations.map((a, idx) => (
                                <li key={idx} className="truncate">{a.name || a.label || a.id}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {selectedNode.apiDetails.deUsage.journeys && selectedNode.apiDetails.deUsage.journeys.length > 0 && (
                          <div>
                            <div className="text-xs font-semibold text-gray-600">Journeys</div>
                            <ul className="list-disc ml-5">
                              {selectedNode.apiDetails.deUsage.journeys.map((j, idx) => (
                                <li key={idx} className="truncate">{j.name || j.label || j.id}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {selectedNode.apiDetails.deUsage.triggeredSends && selectedNode.apiDetails.deUsage.triggeredSends.length > 0 && (
                          <div>
                            <div className="text-xs font-semibold text-gray-600">Triggered Sends</div>
                            <ul className="list-disc ml-5">
                              {selectedNode.apiDetails.deUsage.triggeredSends.map((t, idx) => (
                                <li key={idx} className="truncate">{t.name || t.label || t.id}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {selectedNode.apiDetails.deUsage.queries && selectedNode.apiDetails.deUsage.queries.length > 0 && (
                          <div>
                            <div className="text-xs font-semibold text-gray-600">Queries</div>
                            <ul className="list-disc ml-5">
                              {selectedNode.apiDetails.deUsage.queries.map((q, idx) => (
                                <li key={idx} className="truncate">{q.name || q.label || q.id}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Metadata section - show API details if available */}
              {selectedNode.apiDetails && (
                <div>
                  <h4 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-2">
                    Metadata
                    <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                      Live API Data
                    </span>
                  </h4>
                  <div className="space-y-3">
                    {/* API Data */}
                    <>
                      <div>
                        <label className="text-sm font-medium text-gray-700">Status</label>
                        <p className="text-sm text-gray-900">{selectedNode.apiDetails.status}</p>
                      </div>
                      <div>
                        <label className="text-sm font-medium text-gray-700">Last Modified</label>
                        <p className="text-sm text-gray-900">
                          {selectedNode.apiDetails.lastModified ? new Date(selectedNode.apiDetails.lastModified).toLocaleString() : '—'}
                        </p>
                      </div>
                      <div>
                        <label className="text-sm font-medium text-gray-700">Created Date</label>
                        <p className="text-sm text-gray-900">
                          {selectedNode.apiDetails.createdDate ? new Date(selectedNode.apiDetails.createdDate).toLocaleString() : '—'}
                        </p>
                      </div>
                      {selectedNode.apiDetails.metadata?.recordCount && (
                        <div>
                          <label className="text-sm font-medium text-gray-700">Record Count</label>
                          <p className="text-sm text-gray-900">
                            {selectedNode.apiDetails.metadata.recordCount.toLocaleString()}
                          </p>
                        </div>
                      )}
                      {selectedNode.apiDetails.metadata?.description && (
                        <div>
                          <label className="text-sm font-medium text-gray-700">Description</label>
                          <p className="text-sm text-gray-900">{selectedNode.apiDetails.metadata.description}</p>
                        </div>
                      )}
                      {selectedNode.apiDetails.metadata?.fields && (
                        <div>
                          <label className="text-sm font-medium text-gray-700">Fields</label>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {selectedNode.apiDetails.metadata.fields.map(field => (
                              <span key={field} className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-blue-100 text-blue-800">
                                {field}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  </div>
                </div>
              )}
              {!selectedNode.apiDetails && (
                <div className="text-sm text-gray-500 italic">
                  No additional details available
                </div>
              )}

              {/* Drawer actions: Expand dependencies */}
              <div className="space-y-2">
                <button
                  onClick={expandSelectedNode}
                  disabled={!selectedNodeId || isExpanding}
                  className={`w-full flex items-center justify-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white ${isExpanding ? 'bg-gray-400' : 'bg-indigo-600 hover:bg-indigo-700'} focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-colors`}
                >
                  <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  {isExpanding ? 'Expanding…' : 'Expand Dependencies'}
                </button>

                <button
                  onClick={() => expandSelectedNodeRecursively(3)}
                  disabled={!selectedNodeId || isExpanding}
                  className={`w-full flex items-center justify-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-indigo-700 bg-indigo-50 hover:bg-indigo-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-colors`}
                >
                  <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h4l3-3 4 6 3-2 4 5" />
                  </svg>
                  Expand All (Depth 3)
                </button>

                {(extraGraph.nodes.length > 0 || extraGraph.edges.length > 0) && (
                  <button
                    onClick={resetExpansions}
                    className="w-full flex items-center justify-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-300 transition-colors"
                  >
                    <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.5 4.5l15 15m0-15l-15 15" />
                    </svg>
                    Reset Expansions
                  </button>
                )}
              </div>

              <div>
                <button
                  onClick={() => {
                    const url = selectedNode.apiDetails?.metadata?.mcUrl || '#';
                    window.open(url, '_blank');
                  }}
                  className="w-full flex items-center justify-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
                >
                  <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  Open in Marketing Cloud
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Overlay for drawer */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-40 bg-black bg-opacity-25"
          onClick={() => setDrawerOpen(false)}
        />
      )}
    </div>
  );
};

export default SchemaBuilder;
