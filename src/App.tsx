import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import ReactFlow, {
  Background,
  Controls,
  Node,
  Edge,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  ReactFlowProvider,
  useReactFlow
} from 'reactflow';
import 'reactflow/dist/style.css';
import dagre from 'dagre';
import { v4 as uuidv4 } from 'uuid';
import { Settings, Plus, Trash2, Heart, Pencil, ChevronDown, ChevronRight, Undo2, Download } from 'lucide-react';
import { toPng } from 'html-to-image';
import { jsPDF } from 'jspdf';
import { GoogleGenAI } from "@google/genai";

// --- Types ---
type Gender = 'male' | 'female';

interface Person {
  id: string;
  name: string;
  nameUrdu?: string;
  gender: Gender;
  generation: number;
}

interface Family {
  id: string;
  fatherId?: string;
  motherId?: string;
  childrenIds: string[];
}

// --- Translations ---
const translations = {
  en: {
    appTitle: 'Shijrah - Family Tree',
    addRelative: 'Add Relative',
    connectRelative: 'Connect Relative',
    editNode: 'Edit Person',
    name: 'Name',
    gender: 'Gender',
    male: 'Male',
    female: 'Female',
    save: 'Save',
    cancel: 'Cancel',
    undo: 'Undo',
    generation: 'Generation',
    children: 'Children',
    noChildren: 'Last Member',
    delete: 'Delete',
    relationship: 'Relationship',
    son: 'Son',
    daughter: 'Daughter',
    father: 'Father',
    mother: 'Mother',
    spouse: 'Spouse',
    howIsRelated: 'How is {target} related to {source}?',
    selectSpouse: 'Select Spouse',
    unknownSpouse: 'Unknown / New Spouse',
    downloadPdf: 'Download PDF',
    exporting: 'Exporting...',
  },
  ur: {
    appTitle: 'شجرہ - خاندانی درخت',
    addRelative: 'رشتہ دار شامل کریں',
    connectRelative: 'رشتہ دار جوڑیں',
    editNode: 'فرد میں ترمیم کریں',
    name: 'نام',
    gender: 'صنف',
    male: 'مرد',
    female: 'عورت',
    save: 'محفوظ کریں',
    cancel: 'منسوخ کریں',
    undo: 'واپس',
    generation: 'نسل',
    children: 'اولاد',
    noChildren: 'آخری فرد',
    delete: 'حذف کریں',
    relationship: 'رشتہ',
    son: 'بیٹا',
    daughter: 'بیٹی',
    father: 'والد',
    mother: 'والدہ',
    spouse: 'شریک حیات',
    howIsRelated: '{target} کا {source} سے کیا رشتہ ہے؟',
    selectSpouse: 'شریک حیات منتخب کریں',
    unknownSpouse: 'نامعلوم / نیا شریک حیات',
    downloadPdf: 'پی ڈی ایف ڈاؤن لوڈ کریں',
    exporting: 'برآمد ہو رہا ہے...',
  }
};

// --- Logic ---
function calculateGenerations(persons: Record<string, Person>, families: Record<string, Family>) {
  const gens: Record<string, number> = {};
  
  // Build adjacency list for relative generations
  // graph[personId] = array of { id: string, diff: number }
  const graph: Record<string, { id: string, diff: number }[]> = {};
  
  Object.keys(persons).forEach(id => {
    graph[id] = [];
  });

  Object.values(families).forEach(f => {
    const parents = [];
    if (f.fatherId && persons[f.fatherId]) parents.push(f.fatherId);
    if (f.motherId && persons[f.motherId]) parents.push(f.motherId);
    
    // Spouses have 0 diff
    if (f.fatherId && f.motherId && persons[f.fatherId] && persons[f.motherId]) {
      graph[f.fatherId].push({ id: f.motherId, diff: 0 });
      graph[f.motherId].push({ id: f.fatherId, diff: 0 });
    }
    
    // Parents to children have +1 diff, children to parents have -1 diff
    parents.forEach(p => {
      f.childrenIds.forEach(c => {
        if (graph[p] && graph[c]) {
          graph[p].push({ id: c, diff: 1 });
          graph[c].push({ id: p, diff: -1 });
        }
      });
    });
  });

  const visited = new Set<string>();

  Object.keys(persons).forEach(startId => {
    if (!visited.has(startId)) {
      // BFS for this connected component
      const queue: string[] = [startId];
      gens[startId] = 0;
      visited.add(startId);
      
      const component: string[] = [startId];

      while (queue.length > 0) {
        const curr = queue.shift()!;
        const currGen = gens[curr];
        
        graph[curr].forEach(neighbor => {
          if (!visited.has(neighbor.id)) {
            gens[neighbor.id] = currGen + neighbor.diff;
            visited.add(neighbor.id);
            queue.push(neighbor.id);
            component.push(neighbor.id);
          }
        });
      }
      
      // Find min generation in this component
      let minGen = Infinity;
      component.forEach(id => {
        if (gens[id] < minGen) minGen = gens[id];
      });
      
      // Shift so minGen becomes 1
      const shift = 1 - minGen;
      component.forEach(id => {
        gens[id] += shift;
      });
    }
  });

  const updatedPersons = { ...persons };
  Object.keys(updatedPersons).forEach(id => {
    updatedPersons[id] = { ...updatedPersons[id], generation: gens[id] || 1 };
  });

  return updatedPersons;
}

const getLayoutedElements = (nodes: Node[], edges: Edge[]) => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  
  dagreGraph.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 80 });

  nodes.forEach((node) => {
    if (node.type === 'union') {
       dagreGraph.setNode(node.id, { width: 20, height: 20 });
    } else {
       const name = node.data?.name || '';
       const nameUrdu = node.data?.nameUrdu || '';
       const displayLength = Math.max(name.length, nameUrdu.length);
       const estimatedWidth = Math.max(140, displayLength * 10 + 20);
       dagreGraph.setNode(node.id, { width: estimatedWidth, height: 80 });
    }
  });

  edges.forEach((edge) => {
    let weight = 1;
    if (edge.targetHandle === 'union-target') {
      weight = 100; // High weight to keep parents close to their union node
    }
    dagreGraph.setEdge(edge.source, edge.target, { weight, minlen: 1 });
  });

  try {
    dagre.layout(dagreGraph);
  } catch (e) {
    console.error("Dagre layout error", e);
  }

  const newNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    let x = nodeWithPosition ? nodeWithPosition.x : 0;
    let y = nodeWithPosition ? nodeWithPosition.y : 0;
    
    const nodeWidth = nodeWithPosition ? nodeWithPosition.width : (node.type === 'union' ? 20 : 140);
    const nodeHeight = nodeWithPosition ? nodeWithPosition.height : (node.type === 'union' ? 20 : 80);

    if (node.type === 'union') {
      // Align union node Y coordinate with its parents
      const parentEdges = edges.filter(e => e.target === node.id);
      if (parentEdges.length > 0) {
        const parentNode = dagreGraph.node(parentEdges[0].source);
        if (parentNode) {
          y = parentNode.y;
        }
      }
    }

    return {
      ...node,
      position: {
        x: x - (nodeWidth / 2),
        y: y - (nodeHeight / 2),
      },
      style: { ...node.style, width: nodeWidth, height: nodeHeight }
    };
  });

  return { nodes: newNodes, edges };
};

// --- Components ---
const PersonNode = ({ data }: any) => {
  const isUrdu = data.lang === 'ur';
  const t = translations[data.lang as keyof typeof translations];
  
  const isMale = data.gender === 'male';
  const isRoot = data.isRoot;
  
  let bgColor = isMale ? 'bg-[#064e3b]' : 'bg-[#4a044e]';
  let borderColor = isMale ? 'border-[#10b981]' : 'border-[#ec4899]';
  
  if (isRoot) {
    borderColor = 'border-[#fbbf24]';
  }

  const handleStyle = { width: 20, height: 20, background: '#94a3b8', border: '2px solid #1e293b', cursor: 'pointer', zIndex: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%' };
  const targetHandleStyle = { width: 36, height: 36, background: 'transparent', border: 'none', zIndex: 10, borderRadius: '50%' };

  const displayName = isUrdu && data.nameUrdu ? data.nameUrdu : data.name;

  return (
    <div className={`group relative flex flex-col items-center justify-center p-3 rounded-2xl border-2 ${bgColor} ${borderColor} shadow-lg text-white ${isUrdu ? 'font-urdu dir-rtl' : ''}`} style={{ width: '100%', height: '100%', minWidth: 140 }}>
      
      {/* Hidden default handles for layout edges */}
      <Handle type="target" position={Position.Top} id="top-target" className="opacity-0" style={{ pointerEvents: 'none' }} />
      <Handle type="source" position={Position.Bottom} id="bottom-source" className="opacity-0" style={{ pointerEvents: 'none', top: '50%' }} />

      {/* Interactive Handles */}
      <Handle type="source" position={Position.Top} id="top-interactive" style={{...handleStyle, top: -10}} onClick={(e) => { e.stopPropagation(); data.onAddRelative(data.id); }}>
        <Plus size={12} className="text-[#0f172a]" />
      </Handle>
      <Handle type="target" position={Position.Top} id="top-interactive-target" style={{...targetHandleStyle, top: -18}} />
      
      <Handle type="source" position={Position.Bottom} id="bottom-interactive" style={{...handleStyle, bottom: -10}} onClick={(e) => { e.stopPropagation(); data.onAddRelative(data.id); }}>
        <Plus size={12} className="text-[#0f172a]" />
      </Handle>
      <Handle type="target" position={Position.Bottom} id="bottom-interactive-target" style={{...targetHandleStyle, bottom: -18}} />
      
      <Handle type="source" position={Position.Left} id="left-interactive" style={{...handleStyle, left: -10}} onClick={(e) => { e.stopPropagation(); data.onAddRelative(data.id); }}>
        <Plus size={12} className="text-[#0f172a]" />
      </Handle>
      <Handle type="target" position={Position.Left} id="left-interactive-target" style={{...targetHandleStyle, left: -18}} />
      
      <Handle type="source" position={Position.Right} id="right-interactive" style={{...handleStyle, right: -10}} onClick={(e) => { e.stopPropagation(); data.onAddRelative(data.id); }}>
        <Plus size={12} className="text-[#0f172a]" />
      </Handle>
      <Handle type="target" position={Position.Right} id="right-interactive-target" style={{...targetHandleStyle, right: -18}} />

      {isRoot && <div className="absolute -top-4 text-yellow-400 text-xl drop-shadow-md">👑</div>}

      <button 
        className="absolute top-1 right-1 p-1 bg-black/30 rounded hover:bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => { e.stopPropagation(); data.onEditNode(data.id); }}
        title={t.editNode}
      >
        <Pencil size={12} className="text-white" />
      </button>

      <div className="text-center w-full mt-1">
        <h3 className="font-bold text-sm whitespace-nowrap" title={displayName}>{displayName}</h3>
        <div className="text-[10px] text-gray-300 mt-1 flex justify-center items-center gap-1">
          <span>{t.generation} {data.generation}</span>
          <span>•</span>
          <span>{data.childrenCount > 0 ? `${data.childrenCount} ${t.children}` : t.noChildren}</span>
        </div>
      </div>

      {data.hasFamily && (
        <div className="absolute -bottom-3 bg-[#1e293b] rounded-full p-0.5 border border-gray-600 shadow-md">
          {data.isExpanded ? <ChevronDown size={14} className="text-gray-300" /> : <ChevronRight size={14} className="text-gray-300" />}
        </div>
      )}
    </div>
  );
};

const UnionNode = () => {
  return (
    <div className="w-3 h-3 rounded-full bg-pink-500 border-2 border-[#0f172a] shadow-md z-10">
      <Handle type="target" position={Position.Top} id="union-target" className="opacity-0" style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }} />
      <Handle type="source" position={Position.Bottom} id="union-source" className="opacity-0" style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }} />
    </div>
  );
};

const nodeTypes = {
  person: PersonNode,
  union: UnionNode,
};

const Sidebar = ({ isOpen, mode, targetId, sourceId, persons, families, onSave, onCancel, onDelete, lang }: any) => {
  const t = translations[lang as keyof typeof translations];
  const isUrdu = lang === 'ur';
  
  const [name, setName] = useState('');
  const [nameUrdu, setNameUrdu] = useState('');
  const [gender, setGender] = useState<'male' | 'female'>('male');
  const [relationship, setRelationship] = useState('son');
  const [selectedFamilyId, setSelectedFamilyId] = useState('');

  useEffect(() => {
    if (isOpen) {
      if (mode === 'edit' && targetId) {
        setName(persons[targetId]?.name || '');
        setNameUrdu(persons[targetId]?.nameUrdu || '');
        setGender(persons[targetId]?.gender || 'male');
      } else if (mode === 'connect_relative') {
        setName('');
        setNameUrdu('');
        setGender('male');
        setRelationship('child');
        setSelectedFamilyId('');
      } else {
        setName('');
        setNameUrdu('');
        setGender('male');
        setRelationship('son');
        setSelectedFamilyId('');
      }
    }
  }, [isOpen, mode, targetId, persons]);

  const parentIdForSpouseSelection = useMemo(() => {
    if (mode === 'add_relative' && (relationship === 'son' || relationship === 'daughter')) return targetId;
    if (mode === 'connect_relative' && relationship === 'child') return sourceId;
    if (mode === 'connect_relative' && relationship === 'parent') return targetId;
    return null;
  }, [mode, relationship, targetId, sourceId]);

  const personFamilies = useMemo(() => {
    if (!parentIdForSpouseSelection || !families) return [];
    return Object.values(families).filter((f: any) => f.fatherId === parentIdForSpouseSelection || f.motherId === parentIdForSpouseSelection);
  }, [parentIdForSpouseSelection, families]);

  const canAddSpouse = useMemo(() => {
    if (!families || !persons) return true;
    if (mode === 'add_relative' && targetId) {
      const isMale = persons[targetId]?.gender === 'male';
      const spouseCount = Object.values(families).filter((f: any) => f.fatherId === targetId || f.motherId === targetId).length;
      return isMale ? spouseCount < 4 : spouseCount < 1;
    }
    if (mode === 'connect_relative' && targetId && sourceId) {
      const isTargetMale = persons[targetId]?.gender === 'male';
      const isSourceMale = persons[sourceId]?.gender === 'male';
      
      if (isTargetMale === isSourceMale) return false;

      const targetSpouseCount = Object.values(families).filter((f: any) => f.fatherId === targetId || f.motherId === targetId).length;
      const sourceSpouseCount = Object.values(families).filter((f: any) => f.fatherId === sourceId || f.motherId === sourceId).length;
      
      const targetCanAdd = isTargetMale ? targetSpouseCount < 4 : targetSpouseCount < 1;
      const sourceCanAdd = isSourceMale ? sourceSpouseCount < 4 : sourceSpouseCount < 1;
      
      return targetCanAdd && sourceCanAdd;
    }
    return true;
  }, [mode, targetId, sourceId, persons, families]);

  useEffect(() => {
    if (personFamilies.length > 0 && !selectedFamilyId) {
      setSelectedFamilyId(personFamilies[0].id);
    }
  }, [personFamilies, selectedFamilyId]);

  const handleRelationshipChange = (rel: string) => {
    setRelationship(rel);
    if (rel === 'son' || rel === 'father') setGender('male');
    if (rel === 'daughter' || rel === 'mother') setGender('female');
  };

  if (!isOpen) return null;

  let title = '';
  if (mode === 'add_relative') title = t.addRelative;
  if (mode === 'connect_relative') title = t.connectRelative;
  if (mode === 'edit') title = t.editNode;

  const isSaveDisabled = !name.trim() && !nameUrdu.trim();

  return (
    <div className={`absolute top-0 ${isUrdu ? 'left-0' : 'right-0'} w-80 h-full bg-[#1e293b] border-${isUrdu ? 'r' : 'l'} border-gray-700 shadow-2xl p-6 z-50 flex flex-col ${isUrdu ? 'dir-rtl font-urdu' : ''}`}>
      <h2 className="text-xl font-bold text-white mb-6">{title}</h2>
      
      <div className="flex-1 flex flex-col gap-4">
        {(mode === 'add_relative' || mode === 'connect_relative') && (
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              {mode === 'connect_relative' && sourceId && targetId 
                ? t.howIsRelated.replace('{target}', persons[targetId]?.name).replace('{source}', persons[sourceId]?.name)
                : t.relationship}
            </label>
            <select 
              value={relationship}
              onChange={e => handleRelationshipChange(e.target.value)}
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-emerald-500"
            >
              {mode === 'connect_relative' ? (
                <>
                  <option value="child">{persons[sourceId]?.gender === 'male' ? t.son : t.daughter}</option>
                  <option value="parent">{persons[sourceId]?.gender === 'male' ? t.father : t.mother}</option>
                  {canAddSpouse && <option value="spouse">{t.spouse}</option>}
                </>
              ) : (
                <>
                  <option value="son">{t.son}</option>
                  <option value="daughter">{t.daughter}</option>
                  <option value="father">{t.father}</option>
                  <option value="mother">{t.mother}</option>
                  {canAddSpouse && <option value="spouse">{t.spouse}</option>}
                </>
              )}
            </select>
          </div>
        )}

        {parentIdForSpouseSelection && personFamilies.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">{t.selectSpouse}</label>
            <select 
              value={selectedFamilyId}
              onChange={e => setSelectedFamilyId(e.target.value)}
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-emerald-500"
            >
              {personFamilies.map((f: any) => {
                const spouseId = f.fatherId === parentIdForSpouseSelection ? f.motherId : f.fatherId;
                const spouseName = spouseId && persons[spouseId] ? persons[spouseId].name : t.unknownSpouse;
                return (
                  <option key={f.id} value={f.id}>{spouseName}</option>
                );
              })}
              {(!persons[parentIdForSpouseSelection] || (persons[parentIdForSpouseSelection].gender === 'male' ? personFamilies.length < 4 : personFamilies.length < 1)) && (
                <option value="new">{t.unknownSpouse}</option>
              )}
            </select>
          </div>
        )}

        {(mode === 'add_relative' || mode === 'edit') && (
          <>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">{t.name} (English)</label>
              <input 
                type="text" 
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-emerald-500"
                autoFocus
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">{t.name} (Urdu)</label>
              <input 
                type="text" 
                value={nameUrdu}
                onChange={e => setNameUrdu(e.target.value)}
                className="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-emerald-500 font-urdu"
                dir="rtl"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">{t.gender}</label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-white cursor-pointer">
                  <input 
                    type="radio" 
                    checked={gender === 'male'} 
                    onChange={() => setGender('male')}
                    className="text-emerald-500 focus:ring-emerald-500"
                  />
                  {t.male}
                </label>
                <label className="flex items-center gap-2 text-white cursor-pointer">
                  <input 
                    type="radio" 
                    checked={gender === 'female'} 
                    onChange={() => setGender('female')}
                    className="text-pink-500 focus:ring-pink-500"
                  />
                  {t.female}
                </label>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="flex flex-col gap-3 mt-8">
        <button 
          onClick={() => onSave({ name, nameUrdu, gender, relationship, selectedFamilyId })}
          disabled={isSaveDisabled}
          className={`w-full font-medium py-2 rounded-lg transition-colors ${isSaveDisabled ? 'bg-gray-600 text-gray-400 cursor-not-allowed' : 'bg-emerald-600 hover:bg-emerald-700 text-white'}`}
        >
          {t.save}
        </button>
        {mode === 'edit' && (
          <button 
            onClick={onDelete}
            className="w-full bg-red-600/20 hover:bg-red-600/40 text-red-500 font-medium py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            <Trash2 size={18} />
            {t.delete}
          </button>
        )}
        <button 
          onClick={onCancel}
          className="w-full bg-gray-700 hover:bg-gray-600 text-white font-medium py-2 rounded-lg transition-colors"
        >
          {t.cancel}
        </button>
      </div>
    </div>
  );
};

function FamilyTreeApp() {
  const [persons, setPersons] = useState<Record<string, Person>>({});
  const [families, setFamilies] = useState<Record<string, Family>>({});
  const [lang, setLang] = useState<'en' | 'ur'>('en');
  const [isExporting, setIsExporting] = useState(false);
  const { fitView } = useReactFlow();
  const [history, setHistory] = useState<{ persons: Record<string, Person>, families: Record<string, Family> }[]>([]);
  
  const [sidebarState, setSidebarState] = useState<{
    isOpen: boolean;
    mode: 'add_relative' | 'connect_relative' | 'edit' | null;
    targetId: string | null;
    sourceId?: string | null;
  }>({ isOpen: false, mode: null, targetId: null });

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});

  const pushHistory = useCallback(() => {
    setHistory(prev => [...prev, { persons: JSON.parse(JSON.stringify(persons)), families: JSON.parse(JSON.stringify(families)) }].slice(-20));
  }, [persons, families]);

  const undo = useCallback(() => {
    if (history.length === 0) return;
    const lastState = history[history.length - 1];
    setPersons(lastState.persons);
    setFamilies(lastState.families);
    setHistory(prev => prev.slice(0, -1));
  }, [history]);

  const downloadPdf = async () => {
    const viewport = document.querySelector('.react-flow__viewport') as HTMLElement;
    if (!viewport) return;

    setIsExporting(true);
    try {
      // Fit view to ensure everything is captured
      await fitView({ padding: 0.2 });
      
      // Wait a bit for fitView to complete and rendering to settle
      await new Promise(resolve => setTimeout(resolve, 500));

      const dataUrl = await toPng(viewport, {
        backgroundColor: '#0f172a',
        quality: 1,
        pixelRatio: 2, // Higher quality
      });

      const pdf = new jsPDF({
        orientation: 'landscape',
        unit: 'px',
        format: [viewport.offsetWidth * 2, viewport.offsetHeight * 2]
      });

      pdf.addImage(dataUrl, 'PNG', 0, 0, viewport.offsetWidth * 2, viewport.offsetHeight * 2);
      pdf.save(`family-tree-${new Date().toISOString().split('T')[0]}.pdf`);
    } catch (error) {
      console.error('Error exporting PDF:', error);
    } finally {
      setIsExporting(false);
    }
  };

  const translateNameToUrdu = async (name: string): Promise<string> => {
    if (!name || name.trim() === '') return '';
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Translate the following person name to Urdu script. Only provide the Urdu script, nothing else: "${name}"`,
      });
      return response.text.trim();
    } catch (e) {
      console.error("Translation error", e);
      return '';
    }
  };

  const translateUrduToEnglish = async (urduName: string): Promise<string> => {
    if (!urduName || urduName.trim() === '') return '';
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Translate the following Urdu person name to English script. Only provide the English script, nothing else: "${urduName}"`,
      });
      return response.text.trim();
    } catch (e) {
      console.error("Translation error", e);
      return '';
    }
  };

  useEffect(() => {
    const saved = localStorage.getItem('shijrah_data');
    if (saved) {
      try {
        const { persons, families, expandedNodes: savedExpanded } = JSON.parse(saved);
        setPersons(persons);
        setFamilies(families);
        if (savedExpanded) setExpandedNodes(savedExpanded);
      } catch (e) {
        console.error("Failed to parse saved data");
      }
    } else {
      const rootId = uuidv4();
      setPersons({
        [rootId]: { id: rootId, name: 'نسب', gender: 'male', generation: 1 }
      });
      setExpandedNodes({ [rootId]: true });
    }
  }, []);

  useEffect(() => {
    if (Object.keys(persons).length > 0) {
      localStorage.setItem('shijrah_data', JSON.stringify({ persons, families, expandedNodes }));
    }
  }, [persons, families, expandedNodes]);

  useEffect(() => {
    if (lang === 'ur') {
      const translateMissing = async () => {
        let changed = false;
        const newPersons = { ...persons };
        for (const id in newPersons) {
          if (!newPersons[id].nameUrdu && newPersons[id].name) {
            newPersons[id].nameUrdu = await translateNameToUrdu(newPersons[id].name);
            changed = true;
          }
        }
        if (changed) {
          setPersons(newPersons);
        }
      };
      translateMissing();
    }
  }, [lang]);

  const handleAddRelative = useCallback((nodeId: string) => {
    setSidebarState({ isOpen: true, mode: 'add_relative', targetId: nodeId });
  }, []);

  const handleEditNode = useCallback((nodeId: string) => {
    setSidebarState({ isOpen: true, mode: 'edit', targetId: nodeId });
  }, []);

  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    if (node.type === 'person') {
      setExpandedNodes(prev => ({ ...prev, [node.id]: !prev[node.id] }));
    }
  }, []);

  const onConnect = useCallback((params: any) => {
    const { source, target } = params;
    if (!source || !target || source === target) return;
    
    // Check if they are already in the same family
    // Only allow connecting person to person
    if (persons[source] && persons[target]) {
      setSidebarState({ isOpen: true, mode: 'connect_relative', sourceId: source, targetId: target });
    }
  }, [persons]);

  const handleSave = async (formData: { name: string, nameUrdu?: string, gender: 'male' | 'female', relationship: string, selectedFamilyId?: string }) => {
    const { mode, targetId, sourceId } = sidebarState;
    if (!targetId) return;

    pushHistory();

    let nameUrdu = formData.nameUrdu || '';
    let name = formData.name || '';

    if (!nameUrdu && name) {
      nameUrdu = await translateNameToUrdu(name);
    } else if (!name && nameUrdu) {
      name = await translateUrduToEnglish(nameUrdu);
    }

    if (mode === 'add_relative') {
      const rel = formData.relationship;
      const newPersonId = uuidv4();
      const newPerson: Person = {
        id: newPersonId,
        name: name || 'Unknown',
        nameUrdu: nameUrdu,
        gender: formData.gender,
        generation: 1,
      };
      let newFamilies = { ...families };

      if (rel === 'father' || rel === 'mother') {
        const existingFamily = (Object.values(newFamilies) as Family[]).find(f => f.childrenIds.includes(targetId));
        if (existingFamily) {
          if (rel === 'father') existingFamily.fatherId = newPersonId;
          if (rel === 'mother') existingFamily.motherId = newPersonId;
        } else {
          const newFamilyId = uuidv4();
          newFamilies[newFamilyId] = {
            id: newFamilyId,
            fatherId: rel === 'father' ? newPersonId : undefined,
            motherId: rel === 'mother' ? newPersonId : undefined,
            childrenIds: [targetId]
          };
        }
      } else if (rel === 'son' || rel === 'daughter') {
        const personFamilies = (Object.values(newFamilies) as Family[]).filter(f => f.fatherId === targetId || f.motherId === targetId);
        
        if (formData.selectedFamilyId && formData.selectedFamilyId !== 'new' && newFamilies[formData.selectedFamilyId]) {
          newFamilies[formData.selectedFamilyId].childrenIds.push(newPersonId);
        } else if (personFamilies.length === 1 && !formData.selectedFamilyId) {
          personFamilies[0].childrenIds.push(newPersonId);
        } else {
          const newFamilyId = uuidv4();
          const isTargetMale = persons[targetId].gender === 'male';
          newFamilies[newFamilyId] = {
            id: newFamilyId,
            fatherId: isTargetMale ? targetId : undefined,
            motherId: isTargetMale ? undefined : targetId,
            childrenIds: [newPersonId]
          };
        }
      } else if (rel === 'spouse') {
        const existingEmptyFamily = (Object.values(newFamilies) as Family[]).find(f => 
          (f.fatherId === targetId && !f.motherId) || 
          (f.motherId === targetId && !f.fatherId)
        );
        if (existingEmptyFamily) {
          const isNewMale = newPerson.gender === 'male';
          if (isNewMale) existingEmptyFamily.fatherId = newPersonId;
          else existingEmptyFamily.motherId = newPersonId;
        } else {
          const newFamilyId = uuidv4();
          const isTargetMale = persons[targetId].gender === 'male';
          newFamilies[newFamilyId] = {
            id: newFamilyId,
            fatherId: isTargetMale ? targetId : newPersonId,
            motherId: isTargetMale ? newPersonId : targetId,
            childrenIds: []
          };
        }
      }
      setPersons(prev => ({ ...prev, [newPersonId]: newPerson }));
      setFamilies(newFamilies);
      setExpandedNodes(prev => ({ ...prev, [targetId]: true, [newPersonId]: true }));

    } else if (mode === 'connect_relative' && sourceId) {
      const rel = formData.relationship;
      const sourcePerson = persons[sourceId];
      const targetPerson = persons[targetId];
      let newFamilies = { ...families };

      if (rel === 'parent') {
        // Target is parent of Source
        const sourceFamilyAsChild = (Object.values(newFamilies) as Family[]).find(f => f.childrenIds.includes(sourceId));
        
        let targetFamilyAsParent = undefined;
        if (formData.selectedFamilyId && formData.selectedFamilyId !== 'new' && newFamilies[formData.selectedFamilyId]) {
          targetFamilyAsParent = newFamilies[formData.selectedFamilyId];
        } else {
          const personFamilies = (Object.values(newFamilies) as Family[]).filter(f => f.fatherId === targetId || f.motherId === targetId);
          if (personFamilies.length === 1) targetFamilyAsParent = personFamilies[0];
        }

        const isTargetMale = targetPerson.gender === 'male';

        if (sourceFamilyAsChild && targetFamilyAsParent && sourceFamilyAsChild.id !== targetFamilyAsParent.id) {
           // Merge sourceFamilyAsChild into targetFamilyAsParent
           targetFamilyAsParent.childrenIds = Array.from(new Set([...targetFamilyAsParent.childrenIds, ...sourceFamilyAsChild.childrenIds]));
           if (!targetFamilyAsParent.fatherId && sourceFamilyAsChild.fatherId) targetFamilyAsParent.fatherId = sourceFamilyAsChild.fatherId;
           if (!targetFamilyAsParent.motherId && sourceFamilyAsChild.motherId) targetFamilyAsParent.motherId = sourceFamilyAsChild.motherId;
           delete newFamilies[sourceFamilyAsChild.id];
        } else if (sourceFamilyAsChild) {
           if (isTargetMale) sourceFamilyAsChild.fatherId = targetId;
           else sourceFamilyAsChild.motherId = targetId;
        } else if (targetFamilyAsParent) {
           if (!targetFamilyAsParent.childrenIds.includes(sourceId)) {
             targetFamilyAsParent.childrenIds.push(sourceId);
           }
        } else {
           const newFamilyId = uuidv4();
           newFamilies[newFamilyId] = {
             id: newFamilyId,
             fatherId: isTargetMale ? targetId : undefined,
             motherId: isTargetMale ? undefined : targetId,
             childrenIds: [sourceId]
           };
        }
      } else if (rel === 'child') {
        // Target is child of Source
        const targetFamilyAsChild = (Object.values(newFamilies) as Family[]).find(f => f.childrenIds.includes(targetId));
        
        let sourceFamilyAsParent = undefined;
        if (formData.selectedFamilyId && formData.selectedFamilyId !== 'new' && newFamilies[formData.selectedFamilyId]) {
          sourceFamilyAsParent = newFamilies[formData.selectedFamilyId];
        } else {
          const personFamilies = (Object.values(newFamilies) as Family[]).filter(f => f.fatherId === sourceId || f.motherId === sourceId);
          if (personFamilies.length === 1) sourceFamilyAsParent = personFamilies[0];
        }

        if (targetFamilyAsChild && sourceFamilyAsParent && targetFamilyAsChild.id !== sourceFamilyAsParent.id) {
           // Merge targetFamilyAsChild into sourceFamilyAsParent
           sourceFamilyAsParent.childrenIds = Array.from(new Set([...sourceFamilyAsParent.childrenIds, ...targetFamilyAsChild.childrenIds]));
           if (!sourceFamilyAsParent.fatherId && targetFamilyAsChild.fatherId) sourceFamilyAsParent.fatherId = targetFamilyAsChild.fatherId;
           if (!sourceFamilyAsParent.motherId && targetFamilyAsChild.motherId) sourceFamilyAsParent.motherId = targetFamilyAsChild.motherId;
           delete newFamilies[targetFamilyAsChild.id];
        } else if (targetFamilyAsChild) {
           const isSourceMale = sourcePerson.gender === 'male';
           if (isSourceMale) targetFamilyAsChild.fatherId = sourceId;
           else targetFamilyAsChild.motherId = sourceId;
        } else if (sourceFamilyAsParent) {
           if (!sourceFamilyAsParent.childrenIds.includes(targetId)) {
             sourceFamilyAsParent.childrenIds.push(targetId);
           }
        } else {
           const newFamilyId = uuidv4();
           const isSourceMale = sourcePerson.gender === 'male';
           newFamilies[newFamilyId] = {
             id: newFamilyId,
             fatherId: isSourceMale ? sourceId : undefined,
             motherId: isSourceMale ? undefined : sourceId,
             childrenIds: [targetId]
           };
        }
      } else if (rel === 'spouse') {
        // Target is spouse of Source
        const sourceEmptyFamily = (Object.values(newFamilies) as Family[]).find(f => 
          (f.fatherId === sourceId && !f.motherId) || 
          (f.motherId === sourceId && !f.fatherId)
        );
        const targetEmptyFamily = (Object.values(newFamilies) as Family[]).find(f => 
          (f.fatherId === targetId && !f.motherId) || 
          (f.motherId === targetId && !f.fatherId)
        );

        const isTargetMale = targetPerson.gender === 'male';
        const isSourceMale = sourcePerson.gender === 'male';

        if (sourceEmptyFamily && targetEmptyFamily && sourceEmptyFamily.id !== targetEmptyFamily.id) {
           // Merge targetEmptyFamily into sourceEmptyFamily
           sourceEmptyFamily.childrenIds = Array.from(new Set([...sourceEmptyFamily.childrenIds, ...targetEmptyFamily.childrenIds]));
           if (isTargetMale) sourceEmptyFamily.fatherId = targetId;
           else sourceEmptyFamily.motherId = targetId;
           delete newFamilies[targetEmptyFamily.id];
        } else if (sourceEmptyFamily) {
           if (isTargetMale) sourceEmptyFamily.fatherId = targetId;
           else sourceEmptyFamily.motherId = targetId;
        } else if (targetEmptyFamily) {
           if (isSourceMale) targetEmptyFamily.fatherId = sourceId;
           else targetEmptyFamily.motherId = sourceId;
        } else {
           const newFamilyId = uuidv4();
           newFamilies[newFamilyId] = {
             id: newFamilyId,
             fatherId: isSourceMale ? sourceId : targetId,
             motherId: isSourceMale ? targetId : sourceId,
             childrenIds: []
           };
        }
      }
      setFamilies(newFamilies);
      setExpandedNodes(prev => ({ ...prev, [targetId]: true, [sourceId]: true }));

    } else if (mode === 'edit') {
      setPersons(prev => ({
        ...prev,
        [targetId]: { ...prev[targetId], name: name, nameUrdu: nameUrdu, gender: formData.gender }
      }));
    }

    setSidebarState({ isOpen: false, mode: null, targetId: null });
  };

  const handleDelete = () => {
    const { targetId } = sidebarState;
    if (!targetId) return;

    pushHistory();

    const idsToDelete = new Set<string>([targetId]);
    const queue = [targetId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      (Object.values(families) as Family[]).forEach(f => {
        if (f.fatherId === currentId || f.motherId === currentId) {
          f.childrenIds.forEach(childId => {
            if (!idsToDelete.has(childId)) {
              idsToDelete.add(childId);
              queue.push(childId);
            }
          });
        }
      });
    }

    const newPersons = { ...persons };
    idsToDelete.forEach(id => delete newPersons[id]);

    const newFamilies = { ...families };
    Object.keys(newFamilies).forEach(fId => {
      const f: Family = { ...newFamilies[fId] };
      
      // If a parent is deleted, they are removed from the family
      if (f.fatherId && idsToDelete.has(f.fatherId)) f.fatherId = undefined;
      if (f.motherId && idsToDelete.has(f.motherId)) f.motherId = undefined;
      
      // Remove deleted children from the family
      f.childrenIds = f.childrenIds.filter(id => !idsToDelete.has(id));
      
      // If the family is now empty or has no parents and no children, delete it
      if (!f.fatherId && !f.motherId && f.childrenIds.length === 0) {
        delete newFamilies[fId];
      } else {
        newFamilies[fId] = f;
      }
    });

    setPersons(newPersons);
    setFamilies(newFamilies);
    setSidebarState({ isOpen: false, mode: null, targetId: null });
  };

  useEffect(() => {
    if (Object.keys(persons).length === 0) return;

    const updatedPersons = calculateGenerations(persons, families);
    const newNodes: Node[] = [];
    const newEdges: Edge[] = [];

    const visiblePersons = new Set<string>();
    const visibleFamilies = new Set<string>();

    const secondaryRoots = new Set<string>();
    (Object.values(families) as Family[]).forEach(f => {
      if (f.fatherId && f.motherId) {
        const fatherHasParents = (Object.values(families) as Family[]).some(fam => fam.childrenIds.includes(f.fatherId!));
        const motherHasParents = (Object.values(families) as Family[]).some(fam => fam.childrenIds.includes(f.motherId!));
        
        if (!fatherHasParents && !motherHasParents) {
          secondaryRoots.add(f.motherId);
        }
      }
    });

    Object.values(updatedPersons).forEach(p => {
      if (p.generation === 1 && !secondaryRoots.has(p.id)) {
        visiblePersons.add(p.id);
      }
    });

    let changed = true;
    while (changed) {
      changed = false;
      Object.values(families).forEach((f: Family) => {
        if (visibleFamilies.has(f.id)) return;

        const fatherVisibleAndExpanded = f.fatherId && visiblePersons.has(f.fatherId) && expandedNodes[f.fatherId];
        const motherVisibleAndExpanded = f.motherId && visiblePersons.has(f.motherId) && expandedNodes[f.motherId];

        if (fatherVisibleAndExpanded || motherVisibleAndExpanded) {
          visibleFamilies.add(f.id);
          changed = true;
          
          if (f.fatherId) visiblePersons.add(f.fatherId);
          if (f.motherId) visiblePersons.add(f.motherId);
          
          f.childrenIds.forEach(childId => {
            visiblePersons.add(childId);
          });
        }
      });
    }

    Object.values(updatedPersons).forEach((person: Person) => {
      if (!visiblePersons.has(person.id)) return;

      let childrenCount = 0;
      let hasFamily = false;
      Object.values(families).forEach((f: Family) => {
        if (f.fatherId === person.id || f.motherId === person.id) {
          childrenCount += f.childrenIds.length;
          hasFamily = true;
        }
      });

      newNodes.push({
        id: person.id,
        type: 'person',
        data: {
          ...person,
          childrenCount,
          hasFamily,
          lang,
          isRoot: person.generation === 1,
          isExpanded: !!expandedNodes[person.id],
          onAddRelative: handleAddRelative,
          onEditNode: handleEditNode,
        },
        position: { x: 0, y: 0 },
      });
    });

    Object.values(families).forEach((family: Family) => {
      if (!visibleFamilies.has(family.id)) return;

      newNodes.push({
        id: family.id,
        type: 'union',
        data: {},
        position: { x: 0, y: 0 },
      });

      if (family.fatherId && visiblePersons.has(family.fatherId)) {
        newEdges.push({
          id: `e-${family.fatherId}-${family.id}`,
          source: family.fatherId,
          sourceHandle: 'bottom-source',
          target: family.id,
          targetHandle: 'union-target',
          type: 'straight',
          style: { stroke: '#10b981', strokeWidth: 1.5 },
        });
      }
      if (family.motherId && visiblePersons.has(family.motherId)) {
        newEdges.push({
          id: `e-${family.motherId}-${family.id}`,
          source: family.motherId,
          sourceHandle: 'bottom-source',
          target: family.id,
          targetHandle: 'union-target',
          type: 'straight',
          style: { stroke: '#ec4899', strokeWidth: 1.5 },
        });
      }

      family.childrenIds.forEach(childId => {
        if (visiblePersons.has(childId)) {
          newEdges.push({
            id: `e-${family.id}-${childId}`,
            source: family.id,
            sourceHandle: 'union-source',
            target: childId,
            targetHandle: 'top-target',
            type: 'smoothstep',
            style: { stroke: '#94a3b8', strokeWidth: 1.5 },
          });
        }
      });
    });

    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(newNodes, newEdges);
    setNodes(layoutedNodes);
    setEdges(layoutedEdges);
  }, [persons, families, lang, expandedNodes, handleAddRelative, handleEditNode, setNodes, setEdges]);

  return (
    <div className="w-full h-screen bg-[#0f172a] flex flex-col overflow-hidden">
      <header className="h-16 bg-[#1e293b] border-b border-gray-800 flex items-center justify-between px-6 z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-emerald-600 rounded-lg flex items-center justify-center">
            <Settings size={20} className="text-white" />
          </div>
          <h1 className={`text-xl font-bold text-white ${lang === 'ur' ? 'font-urdu' : ''}`}>
            {translations[lang].appTitle}
          </h1>
        </div>
        
        <div className="flex items-center gap-4">
          <button 
            onClick={downloadPdf}
            disabled={isExporting}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-full bg-emerald-600 border border-emerald-500 text-sm font-medium transition-colors text-white hover:bg-emerald-500 ${isExporting ? 'opacity-50 cursor-not-allowed' : ''}`}
            title={translations[lang].downloadPdf}
          >
            <Download size={16} />
            <span className={lang === 'ur' ? 'font-urdu' : ''}>
              {isExporting ? translations[lang].exporting : translations[lang].downloadPdf}
            </span>
          </button>
          <button 
            onClick={undo}
            disabled={history.length === 0}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-full bg-gray-800 border border-gray-600 text-sm font-medium transition-colors ${history.length === 0 ? 'opacity-50 cursor-not-allowed text-gray-500' : 'text-gray-300 hover:text-white hover:bg-gray-700'}`}
            title={translations[lang].undo}
          >
            <Undo2 size={16} />
            <span className={lang === 'ur' ? 'font-urdu' : ''}>{translations[lang].undo}</span>
          </button>
          <button 
            onClick={() => setLang(l => l === 'en' ? 'ur' : 'en')}
            className="px-4 py-1.5 rounded-full bg-gray-800 text-gray-300 hover:text-white hover:bg-gray-700 border border-gray-600 text-sm font-medium transition-colors"
          >
            {lang === 'en' ? 'اردو' : 'English'}
          </button>
        </div>
      </header>

      <div className="flex-1 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          fitView
          className="bg-[#0f172a]"
          minZoom={0.1}
          connectionRadius={50}
        >
          <Background color="#1e293b" gap={20} size={2} />
          <Controls />
        </ReactFlow>

        <Sidebar 
          isOpen={sidebarState.isOpen}
          mode={sidebarState.mode}
          targetId={sidebarState.targetId}
          sourceId={sidebarState.sourceId}
          persons={persons}
          families={families}
          onSave={handleSave}
          onCancel={() => setSidebarState({ isOpen: false, mode: null, targetId: null })}
          onDelete={handleDelete}
          lang={lang}
        />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <FamilyTreeApp />
    </ReactFlowProvider>
  );
}
