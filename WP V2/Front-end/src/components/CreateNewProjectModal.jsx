import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../api/client';
import { getApiErrorMessage } from '../utils/apiErrors';
import { emptyTask } from '../constants/projectTaskFields';
import {
  extractDriveFileId,
  fetchSpreadsheetSheetTitles,
  importTasksFromGoogleSheet,
  importTasksFromSheetRows,
} from '../utils/googleSheets';
import { buildTaskNameOptions, findMatchingNrm, getTaskNameOptionsForRow } from '../utils/nrmTasks';
import { getCredentialsFromEnv, ttGetProjects, ttLogin } from '../utils/timeTracking';
import Modal from './Modal';
import DisplayDateInput from './DisplayDateInput';
import AvailabilityRowActions from './AvailabilityRowActions';

/** Configured Google Drive quotations folder (see GOOGLE_DRIVE_QUOTATIONS_FOLDER_ID). */
const QUOTATIONS_DRIVE_FOLDER_URL =
  import.meta.env.VITE_GOOGLE_DRIVE_QUOTATIONS_FOLDER_URL
  || 'https://drive.google.com/drive/folders/1QGML2ZNKqAr252zHNYHT9O8TqdyKAw9B';

function monthBounds() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const fmt = (date) => date.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

function emptyRow(defaults) {
  return {
    ...emptyTask(),
    task_name: '',
    doc_supply: defaults.start,
    completion: defaults.end,
    pp: defaults.pp,
  };
}

function recalculatePlan(row) {
  const pd = parseFloat(row.pd || 0);
  const dl = parseFloat(row.dl || 0);
  const est = parseFloat(row.est || 0);
  const buf = parseFloat(row.buf || 0);
  const adj = parseFloat(row.adj || 0);
  const base = pd || dl || est;
  return base ? String(base + buf + adj) : row.plan || '';
}

function recalculatePri(row) {
  const rap = parseFloat(row.rap || 0);
  const pp = parseFloat(row.pp || 0);
  if (!rap && !pp) return row.pri || '';
  return String(rap + pp);
}

const DEFAULT_PART_NAME = 'Part A';

/** TT / WP job codes: must start with at least four digits (e.g. 1234 …). */
function startsWithFourDigitJob(name) {
  return /^\d{4}/.test(String(name || '').trim());
}

function leadingJobNumber(name) {
  const match = String(name || '').trim().match(/^(\d+)/);
  if (!match) {
    return Number.MAX_SAFE_INTEGER;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function quotationLooksUsable(file) {
  return Boolean(file?.format_compatible || file?.has_tasks || file?.is_quotation_form);
}

function normalizeSheetMatchText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_\-–—]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function pickPreferredSheetName(titles, currentName = '', projectName = '') {
  const list = Array.isArray(titles) ? titles.map((title) => String(title || '').trim()).filter(Boolean) : [];
  if (!list.length) return currentName || 'Adjudication - TEMPL';
  const current = String(currentName || '').trim();
  if (current && list.includes(current)) return current;

  const project = String(projectName || '').trim();
  const jobMatch = project.match(/^(\d{4,})/);
  if (jobMatch) {
    const job = jobMatch[1];
    const byJob = list.find((title) => title.includes(job));
    if (byJob) return byJob;
  }
  if (project) {
    const projectNorm = normalizeSheetMatchText(project);
    // Prefer longest sheet title contained in the project name (e.g. "Southern Grove").
    const ranked = list
      .map((title) => {
        const titleNorm = normalizeSheetMatchText(title);
        if (!titleNorm || titleNorm.length < 3) return null;
        if (titleNorm === projectNorm) return { title, score: 1000 + titleNorm.length };
        if (projectNorm.includes(titleNorm)) return { title, score: 500 + titleNorm.length };
        if (titleNorm.includes(projectNorm)) return { title, score: 300 + titleNorm.length };
        return null;
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    if (ranked[0]) return ranked[0].title;
  }

  const preferred = list.find((title) => /^adjudication\s*-\s*templ$/i.test(title));
  return preferred || list[0];
}

function mergeQuotationFiles(...lists) {
  const seen = new Set();
  const merged = [];
  lists.flat().forEach((file) => {
    if (!file || !quotationLooksUsable(file)) return;
    const id = String(file.id || file.webViewLink || '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    merged.push(file);
  });
  merged.sort((a, b) => {
    const rank = (file) => (file.format_compatible || file.is_quotation_form ? 0 : file.has_tasks ? 1 : 2);
    const diff = rank(a) - rank(b);
    if (diff !== 0) return diff;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  return merged;
}

export default function CreateNewProjectModal({
  open,
  onClose,
  projects,
  onSuccess,
  initialValues = null,
  salesToolProposalId = null,
  salesToolSummary = null,
  ttSummary = null,
}) {
  const bounds = monthBounds();
  const [nrms, setNrms] = useState([]);
  const [ttProjects, setTtProjects] = useState([]);
  const [loadHints, setLoadHints] = useState([]);
  const [form, setForm] = useState({
    name: '',
    color: '#6b7280',
    status: 'active',
    part_name: DEFAULT_PART_NAME,
    pp: '',
    doc_supply: bounds.start,
    completion: bounds.end,
  });
  const [rows, setRows] = useState([emptyRow({ start: bounds.start, end: bounds.end, pp: '' })]);
  const [sheetUrl, setSheetUrl] = useState('');
  const [sheetName, setSheetName] = useState('Adjudication - TEMPL');
  const [sheetTitles, setSheetTitles] = useState([]);
  const [loadingSheetTitles, setLoadingSheetTitles] = useState(false);
  const [matchedQuotations, setMatchedQuotations] = useState([]);
  const [lookingUpQuotations, setLookingUpQuotations] = useState(false);
  const [linkedSalesToolProposalId, setLinkedSalesToolProposalId] = useState(null);
  const [autofilledFields, setAutofilledFields] = useState(() => new Set());
  const [lookupSources, setLookupSources] = useState([]);
  const [lookupHint, setLookupHint] = useState('');
  const [isImportMode, setIsImportMode] = useState(false);
  const [importing, setImporting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const lookupSeqRef = useRef(0);
  const activeSalesToolProposalId = salesToolProposalId || linkedSalesToolProposalId;

  const markAutofilled = (...fields) => {
    setAutofilledFields((current) => {
      const next = new Set(current);
      fields.filter(Boolean).forEach((field) => next.add(field));
      return next;
    });
  };

  const clearAutofilled = (...fields) => {
    const keys = fields.filter(Boolean);
    if (!keys.length) {
      setAutofilledFields(new Set());
      return;
    }
    setAutofilledFields((current) => {
      const next = new Set(current);
      keys.forEach((field) => next.delete(field));
      return next;
    });
  };

  const isAutofilled = (field) => autofilledFields.has(field);

  const applyInitialValues = (values) => {
    if (!values || typeof values !== 'object') {
      return;
    }
    const nextBounds = monthBounds();
    const docSupply = String(values.doc_supply || nextBounds.start).slice(0, 10);
    const completion = String(values.completion || nextBounds.end).slice(0, 10);
    setForm({
      name: String(values.name || ''),
      color: String(values.color || '#6b7280'),
      status: String(values.status || 'active'),
      part_name: String(values.part_name || DEFAULT_PART_NAME),
      pp: String(values.pp || ''),
      doc_supply: docSupply,
      completion,
    });
    const taskRows = Array.isArray(values.tasks) && values.tasks.length
      ? values.tasks.map((task) => ({
        ...emptyRow({ start: docSupply, end: completion, pp: values.pp || '' }),
        task_name: String(task.task_name || ''),
        est: task.est != null ? String(task.est) : '',
        dl: task.dl != null ? String(task.dl) : '',
        plan: task.plan != null ? String(task.plan) : (task.est != null ? String(task.est) : ''),
        rap: task.rap != null ? String(task.rap) : '',
        pp: task.pp != null ? String(task.pp) : String(values.pp || ''),
        pri: task.pri != null ? String(task.pri) : '',
        doc_supply: String(task.doc_supply || docSupply).slice(0, 10),
        completion: String(task.completion || completion).slice(0, 10),
      }))
      : [emptyRow({ start: docSupply, end: completion, pp: values.pp || '' })];
    setRows(taskRows);
    const quotations = Array.isArray(values.quotations) ? values.quotations : [];
    setMatchedQuotations(quotations);
    if (values.sheet_url) {
      setSheetUrl(String(values.sheet_url));
    } else if (quotations[0]?.webViewLink) {
      setSheetUrl(String(quotations[0].webViewLink));
    }
    if (values.sheet_name) {
      setSheetName(String(values.sheet_name));
    } else if (quotations[0]?.sheet_name) {
      setSheetName(String(quotations[0].sheet_name));
    }
  };

  const taskNameOptions = useMemo(() => buildTaskNameOptions(nrms), [nrms]);

  const projectNameSuggestions = useMemo(() => {
    const candidates = [];

    (ttProjects || []).forEach((project) => {
      const name = String(project?.name || '').trim();
      if (!startsWithFourDigitJob(name)) {
        return;
      }
      candidates.push({
        name,
        jobNumber: leadingJobNumber(name),
      });
    });

    (projects || []).forEach((project) => {
      const name = String(project?.name || '').trim();
      if (!startsWithFourDigitJob(name)) {
        return;
      }
      candidates.push({
        name,
        jobNumber: leadingJobNumber(name),
      });
    });

    candidates.sort((a, b) => {
      if (a.jobNumber !== b.jobNumber) {
        return b.jobNumber - a.jobNumber;
      }
      return a.name.localeCompare(b.name);
    });

    const seen = new Set();
    const names = [];
    candidates.forEach((item) => {
      const key = item.name.toLowerCase();
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      names.push(item.name);
    });

    return names;
  }, [projects, ttProjects]);

  const filteredProjectNameSuggestions = useMemo(() => {
    const needle = String(form.name || '').trim().toLowerCase();
    if (!needle) {
      return projectNameSuggestions.slice(0, 80);
    }
    return projectNameSuggestions
      .filter((name) => name.toLowerCase().includes(needle))
      .slice(0, 80);
  }, [form.name, projectNameSuggestions]);

  const applyLookupResult = (payload, { preserveName = true } = {}) => {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const sources = Array.isArray(payload.sources) ? payload.sources : [];
    setLookupSources(sources);
    const filled = [];

    const quotations = mergeQuotationFiles(
      Array.isArray(payload.quotations) ? payload.quotations : [],
    );
    setMatchedQuotations(quotations);
    if (quotations.length) {
      filled.push('quotations');
      const preferred = quotations.find((file) => file.format_compatible)
        || quotations.find((file) => file.has_tasks)
        || quotations[0];
      if (preferred?.webViewLink) {
        setSheetUrl(String(preferred.webViewLink));
        filled.push('sheet_url');
      }
      if (preferred) {
        const titles = Array.isArray(preferred.sheet_titles)
          ? preferred.sheet_titles.map((title) => String(title || '').trim()).filter(Boolean)
          : [];
        if (titles.length) {
          setSheetTitles(titles);
        }
        const nextSheet = pickPreferredSheetName(
          titles,
          preferred.sheet_name,
          preserveName ? form.name : (payload.name || form.name),
        );
        if (nextSheet) {
          setSheetName(nextSheet);
          filled.push('sheet_name');
        }
      }
    }

    const nextDoc = payload.doc_supply ? String(payload.doc_supply).slice(0, 10) : '';
    const nextEnd = payload.completion ? String(payload.completion).slice(0, 10) : '';
    if (nextDoc) filled.push('doc_supply');
    if (nextEnd) filled.push('completion');

    setForm((current) => {
      const next = { ...current };
      if (!preserveName && payload.name) {
        next.name = String(payload.name);
      }
      if (nextDoc) {
        next.doc_supply = nextDoc;
      }
      if (nextEnd) {
        next.completion = nextEnd;
      }
      return next;
    });

    if (nextDoc || nextEnd) {
      setRows((current) => current.map((row) => ({
        ...row,
        doc_supply: nextDoc || row.doc_supply,
        completion: nextEnd || row.completion,
      })));
      if (nextDoc) filled.push('task_doc_supply');
      if (nextEnd) filled.push('task_completion');
    }

    if (payload.sales_tool_proposal_id) {
      setLinkedSalesToolProposalId(payload.sales_tool_proposal_id);
    }

    clearAutofilled();
    markAutofilled(...filled);

    if (sources.length || quotations.length || nextDoc || nextEnd) {
      const bits = [];
      if (sources.length) bits.push(sources.join(' + '));
      if (quotations.length) bits.push(`${quotations.length} Quotation form${quotations.length === 1 ? '' : 's'}`);
      if (nextDoc || nextEnd) bits.push('dates');
      setLookupHint(`Auto-filled from ${bits.join(' · ')} — review highlighted fields before saving.`);
    } else {
      setLookupHint('No matching Quotation form or dates found in Outlook, Drive, or Sales Tool yet.');
    }
  };

  const lookupProjectPrefill = async (projectName) => {
    const q = String(projectName || '').trim();
    if (!q || q.length < 3) {
      setLookingUpQuotations(false);
      setLookupHint('');
      setLookupSources([]);
      return;
    }

    const seq = ++lookupSeqRef.current;
    setLookingUpQuotations(true);
    setLookupHint('Searching Outlook, Drive Quotation forms, and Sales Tool…');
    try {
      const response = await api.get('/projects/create-prefill', {
        params: { q, profile: 'deals' },
      });
      if (seq !== lookupSeqRef.current) {
        return;
      }
      applyLookupResult(response.data?.data || {}, { preserveName: true });
    } catch (err) {
      if (seq !== lookupSeqRef.current) {
        return;
      }
      setLookupHint(getApiErrorMessage(err, 'Unable to look up quotation/dates.'));
      setLookupSources([]);
    } finally {
      if (seq === lookupSeqRef.current) {
        setLookingUpQuotations(false);
      }
    }
  };

  useEffect(() => {
    if (!open) return undefined;
    if (initialValues) {
      applyInitialValues(initialValues);
      clearAutofilled();
      setLookupHint('');
      setLookupSources([]);
    } else {
      resetForm();
    }
    return undefined;
    // Prefill when the modal opens, Sales Tool proposal changes, or TT deep-link name arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, salesToolProposalId, initialValues?.name]);

  useEffect(() => {
    if (!open) return undefined;

    let cancelled = false;

    const loadNrms = async () => {
      try {
        const response = await api.get('/nrms');
        if (!cancelled) {
          setNrms(response.data.data ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          setNrms([]);
          setError(getApiErrorMessage(err, 'Unable to load NRM task list.'));
        }
      }
    };

    const loadTtNames = async () => {
      try {
        const creds = getCredentialsFromEnv();
        const { token } = await ttLogin(creds.loginname, creds.password);
        const ttProjectsList = await ttGetProjects(token);
        if (cancelled) {
          return;
        }
        setTtProjects(Array.isArray(ttProjectsList) ? ttProjectsList : []);
      } catch (err) {
        if (!cancelled) {
          setTtProjects([]);
          setLoadHints((current) => [
            ...current.filter((hint) => !hint.startsWith('TT')),
            `TT project names unavailable: ${getApiErrorMessage(err, 'Time Tracking request failed.')}`,
          ]);
        }
      }
    };

    setLoadHints([]);
    loadNrms();
    loadTtNames();

    return () => {
      cancelled = true;
    };
  }, [open]);

  // When project name is typed/selected (or opened via TT deep-link), look up quotation + dates.
  useEffect(() => {
    if (!open || salesToolProposalId) {
      return undefined;
    }

    const projectName = String(form.name || '').trim();
    if (projectName.length < 3) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      lookupProjectPrefill(projectName);
    }, 450);

    return () => {
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, form.name, salesToolProposalId]);

  // When spreadsheet URL changes, load tab names and show a dropdown if there are multiple.
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const url = String(sheetUrl || '').trim();
    if (!url) {
      setSheetTitles([]);
      setLoadingSheetTitles(false);
      return undefined;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoadingSheetTitles(true);
      try {
        let titles = [];
        try {
          titles = await fetchSpreadsheetSheetTitles(url);
        } catch {
          const fileId = extractDriveFileId(url) || '';
          if (fileId) {
            const response = await api.get('/integrations/google-drive/quotations/sheet-titles', {
              params: { file_id: fileId },
            });
            titles = Array.isArray(response.data?.data?.sheet_titles)
              ? response.data.data.sheet_titles
              : [];
          }
        }
        if (cancelled) return;
        const cleaned = (titles || []).map((title) => String(title || '').trim()).filter(Boolean);
        setSheetTitles(cleaned);
        if (cleaned.length) {
          setSheetName((current) => pickPreferredSheetName(cleaned, current, form.name));
        }
      } catch {
        if (!cancelled) {
          setSheetTitles([]);
        }
      } finally {
        if (!cancelled) {
          setLoadingSheetTitles(false);
        }
      }
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, sheetUrl, form.name]);

  const resetForm = () => {
    const nextBounds = monthBounds();
    setForm({
      name: '',
      color: '#6b7280',
      status: 'active',
      part_name: DEFAULT_PART_NAME,
      pp: '',
      doc_supply: nextBounds.start,
      completion: nextBounds.end,
    });
    setRows([emptyRow({ start: nextBounds.start, end: nextBounds.end, pp: '' })]);
    setSheetUrl('');
    setSheetName('Adjudication - TEMPL');
    setSheetTitles([]);
    setLoadingSheetTitles(false);
    setMatchedQuotations([]);
    setLookingUpQuotations(false);
    setLinkedSalesToolProposalId(null);
    clearAutofilled();
    setLookupSources([]);
    setLookupHint('');
    setIsImportMode(false);
    setError('');
    setLoadHints([]);
  };

  const selectMatchedQuotation = (file) => {
    if (!file) return;
    setSheetUrl(String(file.webViewLink || ''));
    const titles = Array.isArray(file.sheet_titles)
      ? file.sheet_titles.map((title) => String(title || '').trim()).filter(Boolean)
      : [];
    if (titles.length) {
      setSheetTitles(titles);
      setSheetName(pickPreferredSheetName(titles, file.sheet_name, form.name || file.project_name));
    } else {
      setSheetName(String(file.sheet_name || 'Adjudication - TEMPL'));
    }
    markAutofilled('sheet_url', 'sheet_name');
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleOpenDriveFolder = () => {
    window.open(QUOTATIONS_DRIVE_FOLDER_URL, '_blank', 'noopener,noreferrer');
  };

  const handleProjectNameChange = (event) => {
    const nextName = event.target.value;
    setForm((current) => ({ ...current, name: nextName }));
    clearAutofilled('doc_supply', 'completion', 'sheet_url', 'sheet_name', 'quotations', 'task_doc_supply', 'task_completion');
    setLookupHint('');
    setLookupSources([]);
  };

  const updateRow = (index, field, value) => {
    if (field === 'doc_supply') {
      clearAutofilled('task_doc_supply');
    }
    if (field === 'completion') {
      clearAutofilled('task_completion');
    }
    setRows((current) =>
      current.map((row, rowIndex) => {
        if (rowIndex !== index) return row;

        const next = { ...row, [field]: value };

        if (field === 'task_name') {
          const match = findMatchingNrm(value, nrms);
          if (match?.pri != null) {
            next.rap = String(match.pri);
          }
        }

        if (['pd', 'dl', 'est', 'buf', 'adj'].includes(field)) {
          next.plan = recalculatePlan(next);
        }

        if (['rap', 'pp', 'task_name'].includes(field)) {
          next.pri = recalculatePri(next);
        }

        return next;
      }),
    );
  };

  const applyGlobalDates = (field, value) => {
    clearAutofilled(field, field === 'doc_supply' ? 'task_doc_supply' : null, field === 'completion' ? 'task_completion' : null);
    setForm((current) => ({ ...current, [field]: value }));
    if (field === 'doc_supply' || field === 'completion') {
      setRows((current) => current.map((row) => ({ ...row, [field]: value })));
    }
    if (field === 'pp') {
      setRows((current) =>
        current.map((row) => {
          const next = { ...row, pp: value };
          next.pri = recalculatePri(next);
          return next;
        }),
      );
    }
  };

  const addRowBelow = (index) => {
    setRows((current) => {
      const copy = [...current];
      copy.splice(
        index + 1,
        0,
        emptyRow({ start: form.doc_supply, end: form.completion, pp: form.pp }),
      );
      return copy;
    });
  };

  const duplicateRow = (index) => {
    setRows((current) => {
      const copy = [...current];
      copy.splice(index + 1, 0, { ...current[index] });
      return copy;
    });
  };

  const removeRow = (index) => {
    setRows((current) => (current.length === 1 ? current : current.filter((_, i) => i !== index)));
  };

  const handleImport = async (event) => {
    event.preventDefault();
    setImporting(true);
    setError('');

    try {
      let imported;
      const fileId = extractDriveFileId(sheetUrl)
        || matchedQuotations.find((file) => file.webViewLink === sheetUrl)?.id
        || matchedQuotations[0]?.id
        || '';

      // Backend picks the path from mime type: Google Sheet (export/parse or Sheets API)
      // vs Excel (.xlsx/.xls download + parse). Office files cannot use Sheets API directly.
      if (fileId) {
        const response = await api.post('/integrations/google-drive/quotations/import', {
          file_id: fileId,
          sheet_name: sheetName || 'Adjudication - TEMPL',
        });
        const payload = response.data?.data || {};
        if (payload.converted && payload.webViewLink) {
          setSheetUrl(String(payload.webViewLink));
          markAutofilled('sheet_url');
          setLookupHint((current) => (
            `Saved Excel as Google Sheet and imported tasks.${current ? ` ${current}` : ''}`
          ));
          setMatchedQuotations((current) => {
            const converted = {
              id: payload.id,
              name: payload.name || 'Quotation form',
              webViewLink: payload.webViewLink,
              mimeType: payload.mimeType,
              sheet_name: payload.sheet_name || sheetName,
              format_compatible: true,
              has_tasks: true,
              is_quotation_form: true,
            };
            const withoutSource = current.filter((file) => String(file.id) !== String(fileId));
            return mergeQuotationFiles([converted, ...withoutSource]);
          });
        } else if (payload.convert_error) {
          setLookupHint(`Imported from Excel. Google Sheet conversion skipped: ${payload.convert_error}`);
        }
        if (payload.webViewLink && payload.mimeType === 'application/vnd.google-apps.spreadsheet') {
          setSheetUrl(String(payload.webViewLink));
        }
        if (Array.isArray(payload.sheet_titles) && payload.sheet_titles.length) {
          const titles = payload.sheet_titles.map((title) => String(title || '').trim()).filter(Boolean);
          setSheetTitles(titles);
          setSheetName(pickPreferredSheetName(titles, payload.sheet_name || sheetName, form.name));
        }
        if (Array.isArray(payload.rows) && payload.rows.length) {
          if (payload.sheet_name) {
            setSheetName(String(payload.sheet_name));
          }
          imported = await importTasksFromSheetRows(payload.rows, nrms);
        } else if (payload.use_sheets_api && payload.webViewLink) {
          imported = await importTasksFromGoogleSheet({
            sheetUrl: payload.webViewLink || sheetUrl,
            sheetName: payload.sheet_name || sheetName,
            nrms,
          });
        }
      }

      if (!imported) {
        imported = await importTasksFromGoogleSheet({
          sheetUrl,
          sheetName,
          nrms,
        });
      }

      const nextRows = imported.map((task) => ({
        ...emptyRow({ start: form.doc_supply, end: form.completion, pp: form.pp }),
        ...task,
        doc_supply: form.doc_supply,
        completion: form.completion,
        pp: form.pp,
        pri: recalculatePri({
          rap: task.rap,
          pp: form.pp,
        }),
      }));

      setRows(nextRows.length ? nextRows : [emptyRow({ start: form.doc_supply, end: form.completion, pp: form.pp })]);
      setIsImportMode(true);
    } catch (err) {
      setError(getApiErrorMessage(err, err.message || 'Failed to import spreadsheet.'));
    } finally {
      setImporting(false);
    }
  };

  const submitProject = async () => {
    setSubmitting(true);
    setError('');

    try {
      const response = await api.post('/projects/with-tasks', {
        name: form.name.trim(),
        color: form.color,
        status: form.status,
        team_id: null,
        part_name: form.part_name.trim(),
        pp: form.pp || null,
        doc_supply: form.doc_supply,
        completion: form.completion,
        tasks: rows.map((row) => ({
          task_name: row.task_name,
          est: row.est ?? 0,
          dl: row.dl,
          plan: row.plan ?? row.est ?? 0,
          rap: row.rap,
          pp: row.pp || form.pp || null,
          pri: row.pri,
          doc_supply: row.doc_supply,
          completion: row.completion,
        })),
      });

      const created = response.data.data;
      if (activeSalesToolProposalId) {
        try {
          await api.post(`/sales-tool/proposals/${activeSalesToolProposalId}/accept`, {
            project_id: created?.id ?? created?.project?.id ?? null,
          });
        } catch {
          // Project was created; acceptance mark is best-effort.
        }
      }
      onSuccess(created);
      handleClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to create project.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    const invalid = rows.filter((row) => !row.task_name || !row.doc_supply || !row.completion);
    if (!form.name.trim() || !form.part_name.trim() || invalid.length > 0) {
      setError('Project name, part name, and task name/dates are required for every row.');
      return;
    }

    const names = rows.map((row) => row.task_name);
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
    if (duplicates.length > 0) {
      setError(`Duplicate task names: ${[...new Set(duplicates)].join(', ')}`);
      return;
    }

    await submitProject();
  };

  return (
    <>
    <Modal open={open} title="Add project / tasks" onClose={handleClose} size="wide">
      <form
        className={`create-project-modal${isImportMode ? ' create-project-modal--imported' : ''}`}
        onSubmit={handleSubmit}
      >
        {salesToolSummary ? (
          <div className="create-project-sales-tool-banner" role="status">
            <strong>From Sales Tool</strong>
            <p>{salesToolSummary}</p>
            {matchedQuotations.length > 0 ? (
              <p className="create-project-sales-tool-quote-hint">
                {matchedQuotations.length} Quotation form{matchedQuotations.length === 1 ? '' : 's'} found — pick one below, then Import tasks.
              </p>
            ) : (
              <p className="create-project-sales-tool-quote-hint muted">
                No Quotation form matched this job yet. Paste a spreadsheet link or open Drive.
              </p>
            )}
          </div>
        ) : null}
        {!salesToolSummary && ttSummary ? (
          <div className="create-project-sales-tool-banner create-project-tt-banner" role="status">
            <strong>From Time Tracking</strong>
            <p>{ttSummary}</p>
          </div>
        ) : null}
        {(lookingUpQuotations || lookupHint) && !salesToolSummary ? (
          <div
            className={`create-project-sales-tool-banner create-project-lookup-banner${autofilledFields.size ? ' is-autofilled' : ''}`}
            role="status"
          >
            <strong>
              {lookingUpQuotations
                ? 'Looking up quotation & dates…'
                : lookupSources.length
                  ? `Matched: ${lookupSources.join(' + ')}`
                  : 'Lookup result'}
            </strong>
            <p className="create-project-sales-tool-quote-hint">
              {lookingUpQuotations
                ? 'Searching Outlook Order Confirmations, Google Drive Quotation forms, and Sales Tool…'
                : lookupHint}
            </p>
            {autofilledFields.size > 0 ? (
              <p className="create-project-sales-tool-quote-hint create-project-unsaved-hint">
                Highlighted fields are auto-filled and unsaved — check them before Save.
              </p>
            ) : null}
          </div>
        ) : null}
        {matchedQuotations.length > 0 ? (
          <div className="create-project-matched-quotations">
            <span className="create-project-matched-quotations-label">Quotation files with tasks</span>
            <ul>
              {matchedQuotations.map((file) => {
                const selected = sheetUrl && file.webViewLink === sheetUrl;
                return (
                  <li key={file.id || file.webViewLink}>
                    <button
                      type="button"
                      className={`create-project-quote-chip${selected ? ' is-selected' : ''}`}
                      onClick={() => selectMatchedQuotation(file)}
                    >
                      <strong>{file.name || 'Quotation'}</strong>
                      {file.format_compatible ? <span className="pill">Adjudication</span> : null}
                      {!file.format_compatible && file.has_tasks ? <span className="pill">Has tasks</span> : null}
                    </button>
                    {file.webViewLink ? (
                      <a href={file.webViewLink} target="_blank" rel="noreferrer" className="create-project-quote-open">
                        Open
                      </a>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        <section className="sheet-import-bar create-project-top-bar">
          <label className={isAutofilled('sheet_url') ? 'is-autofilled' : undefined}>
            Spreadsheet link
            <input
              type="url"
              value={sheetUrl}
              onChange={(e) => {
                clearAutofilled('sheet_url');
                setSheetUrl(e.target.value);
              }}
              placeholder="https://docs.google.com/spreadsheets/d/..."
            />
          </label>
          <label className={isAutofilled('sheet_name') ? 'is-autofilled' : undefined}>
            Sheet name
            {sheetTitles.length > 1 ? (
              <select
                value={sheetTitles.includes(sheetName) ? sheetName : sheetTitles[0]}
                onChange={(e) => {
                  clearAutofilled('sheet_name');
                  setSheetName(e.target.value);
                }}
                disabled={loadingSheetTitles}
              >
                {sheetTitles.map((title) => (
                  <option key={title} value={title}>{title}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={sheetName}
                onChange={(e) => {
                  clearAutofilled('sheet_name');
                  setSheetName(e.target.value);
                }}
                placeholder={loadingSheetTitles ? 'Loading sheets…' : 'Adjudication - TEMPL'}
              />
            )}
          </label>
          <div className="create-project-top-actions availability-toolbar-actions">
            <button
              type="button"
              className="btn btn-secondary btn-compact"
              onClick={handleOpenDriveFolder}
              title="Open the Google Drive quotations folder"
            >
              Open Drive
            </button>
            <button type="button" className="btn btn-secondary btn-compact" onClick={handleClose}>
              Back
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-compact"
              disabled={importing || !sheetName.trim() || !sheetUrl.trim()}
              onClick={handleImport}
            >
              {importing ? 'Importing…' : 'Import tasks'}
            </button>
            <button type="submit" className="btn btn-save btn-compact" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save'}
            </button>
          </div>
        </section>

        {loadHints.length > 0 ? (
          <div className="alert alert-info create-project-load-hints">
            {loadHints.map((hint) => (
              <div key={hint}>{hint}</div>
            ))}
          </div>
        ) : null}

        {error && <div className="alert alert-error">{error}</div>}

        <div className="create-project-meta-grid">
          <label className="create-project-name-field">
            Project name
            <input
              className="create-project-fit-select"
              list="create-project-name-suggestions"
              value={form.name}
              onChange={handleProjectNameChange}
              onBlur={() => {
                const q = String(form.name || '').trim();
                if (q.length >= 3) {
                  lookupProjectPrefill(q);
                }
              }}
              required
              autoComplete="off"
              placeholder={projectNameSuggestions.length ? 'Type or pick a TT / WP project…' : 'Type project name…'}
              title="Type freely or pick from suggestions. Quotation + dates are looked up automatically."
            />
            <datalist id="create-project-name-suggestions">
              {filteredProjectNameSuggestions.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>
          <label>
            Project part
            <input
              value={form.part_name}
              onChange={(e) => setForm({ ...form, part_name: e.target.value })}
              required
            />
          </label>
          <label className={isAutofilled('doc_supply') ? 'is-autofilled' : undefined}>
            Start date
            <DisplayDateInput
              compact
              value={form.doc_supply}
              onChange={(value) => applyGlobalDates('doc_supply', value)}
            />
          </label>
          <label className={isAutofilled('completion') ? 'is-autofilled' : undefined}>
            End date
            <DisplayDateInput
              compact
              value={form.completion}
              onChange={(value) => applyGlobalDates('completion', value)}
            />
          </label>
          <label>
            PP
            <input
              value={form.pp}
              onChange={(e) => applyGlobalDates('pp', e.target.value)}
              title="Even PP values (2, 4, 6…). Use an odd value (3, 5, 7…) to insert between projects."
              placeholder="e.g. 4 or 3 to insert"
            />
          </label>
        </div>

        <div className="create-project-tasks">
          <div className="create-project-tasks-scroll">
            <table className="create-project-task-table">
              <thead>
                <tr>
                  <th>Task name</th>
                  <th>Est</th>
                  <th>DL</th>
                  <th>Plan</th>
                  <th>Doc supply</th>
                  <th>Completion</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const rowTaskOptions = getTaskNameOptionsForRow(
                    taskNameOptions,
                    rows,
                    index,
                    row.task_name,
                  );

                  return (
                  <tr key={index}>
                    <td>
                      {isImportMode ? (
                        <input
                          value={row.task_name}
                          onChange={(e) => updateRow(index, 'task_name', e.target.value)}
                          required
                        />
                      ) : (
                        <select
                          value={row.task_name}
                          onChange={(e) => updateRow(index, 'task_name', e.target.value)}
                          required
                        >
                          <option value="">Select task...</option>
                          {row.task_name && !rowTaskOptions.includes(row.task_name) ? (
                            <option value={row.task_name}>{row.task_name}</option>
                          ) : null}
                          {rowTaskOptions.map((name) => (
                            <option key={name} value={name}>
                              {name}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>
                      <input
                        value={row.est}
                        onChange={(e) => updateRow(index, 'est', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        value={row.dl}
                        onChange={(e) => updateRow(index, 'dl', e.target.value)}
                      />
                    </td>
                    <td>
                      <input value={row.plan} readOnly />
                    </td>
                    <td className={isAutofilled('task_doc_supply') ? 'is-autofilled' : undefined}>
                      <DisplayDateInput
                        compact
                        className="create-project-task-date"
                        value={row.doc_supply}
                        onChange={(value) => updateRow(index, 'doc_supply', value)}
                      />
                    </td>
                    <td className={isAutofilled('task_completion') ? 'is-autofilled' : undefined}>
                      <DisplayDateInput
                        compact
                        className="create-project-task-date"
                        value={row.completion}
                        onChange={(value) => updateRow(index, 'completion', value)}
                      />
                    </td>
                    <td className="create-project-task-actions actions-cell">
                      <AvailabilityRowActions
                        showEdit={false}
                        duplicateBeforeDelete
                        disableDelete={rows.length === 1}
                        onAddBelow={() => addRowBelow(index)}
                        onDelete={() => removeRow(index)}
                        onDuplicate={() => duplicateRow(index)}
                      />
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </form>
    </Modal>
    </>
  );
}
