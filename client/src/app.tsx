import {
  Activity,
  ArrowUpRight,
  Bot,
  Boxes,
  Check,
  ChevronRight,
  Clock3,
  Copy,
  Filter,
  Moon,
  Network,
  Search,
  Sun,
  X,
} from "lucide-react";
import {
  Fragment,
  Suspense,
  lazy,
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode } from "react";
import clsx from "clsx";
import {
  BRAND_MARK_PATHS,
  BRAND_MARK_VIEWBOX,
  BRAND_NAME,
  BRAND_SUBTITLE,
} from "../../src/brand";
import {
  applyTheme,
  resolvePreferredTheme,
  type ThemeMode,
} from "../../src/theme";
import {
  deriveSessionNavItems,
  type SessionNavItem,
} from "../../src/session-nav";

type TraceSummary = {
  costUsd: number | null;
  durationMs: number | null;
  endedAt: string | null;
  flags?: {
    hasHighlights: boolean;
    hasStructuredInput: boolean;
  };
  hierarchy: {
    chatId: string;
    childActorId: string | null;
    delegatedAgentId: string | null;
    guardrailPhase: string | null;
    guardrailType: string | null;
    kind: string;
    rootActorId: string;
    sessionId: string;
    stage: string | null;
    systemType: string | null;
    topLevelAgentId: string;
    watchdogPhase: string | null;
    workflowState: string | null;
  };
  id: string;
  kind: string;
  mode: "invoke" | "stream";
  model: string | null;
  provider: string | null;
  requestPreview: string;
  responsePreview: string;
  startedAt: string;
  status: "pending" | "ok" | "error";
  stream: null | {
    chunkCount: number;
    firstChunkMs: number | null;
  };
  tags: Record<string, string>;
};

type HierarchyNode = {
  children: HierarchyNode[];
  count: number;
  id: string;
  label: string;
  meta: Record<string, any>;
  traceIds: string[];
  type: string;
};

type TraceInsights = {
  highlights: Array<{
    description: string;
    kind: string;
    snippet: string;
    source: string;
    title: string;
  }>;
  structuredInputs: Array<{
    format: "xml";
    role: string;
    snippet: string;
    tags: string[];
  }>;
};

type TraceRecord = {
  context: Record<string, any>;
  endedAt: string | null;
  error: Record<string, any> | null;
  hierarchy: TraceSummary["hierarchy"];
  id: string;
  kind: string;
  mode: "invoke" | "stream";
  model: string | null;
  provider: string | null;
  request: {
    input?: {
      messages?: Array<{ content: any; role: string }>;
      tools?: any[];
    };
    options?: Record<string, any>;
  };
  response: Record<string, any> | null;
  startedAt: string;
  status: "pending" | "ok" | "error";
  stream: null | {
    chunkCount: number;
    events: any[];
    firstChunkMs: number | null;
    reconstructed: Record<string, any>;
  };
  insights?: TraceInsights;
  tags: Record<string, string>;
  usage: Record<string, any> | null;
};

type TraceListPayload = {
  filtered: number;
  items: TraceSummary[];
  total: number;
};

type HierarchyPayload = {
  filtered: number;
  rootNodes: HierarchyNode[];
  total: number;
};

const MESSAGE_COLLAPSE_CHAR_LIMIT = 900;
const MESSAGE_COLLAPSE_LINE_LIMIT = 10;
const MESSAGE_COLLAPSE_HEIGHT_PROSE = "9rem";
const MESSAGE_COLLAPSE_HEIGHT_STRUCTURED = "9rem";
const MESSAGE_COLLAPSE_CHAR_LIMIT_SYSTEM = 500;
const MESSAGE_COLLAPSE_LINE_LIMIT_SYSTEM = 5;
const MESSAGE_COLLAPSE_HEIGHT_PROSE_SYSTEM = "9rem";
const MESSAGE_COLLAPSE_HEIGHT_STRUCTURED_SYSTEM = "9rem";
const TIMELINE_AXIS_STOPS = [0, 0.25, 0.5, 0.75, 1];
const COMPACT_TIMELINE_AXIS_STOPS = [0, 0.5, 1];
const EMPTY_TRACE_INSIGHTS: TraceInsights = {
  highlights: [],
  structuredInputs: [],
};
const MarkdownBlock = lazy(() =>
  import("./markdown-block").then((module) => ({
    default: module.MarkdownBlock,
  })),
);

type Filters = {
  kind: string;
  search: string;
  status: string;
  tags: string;
};

type TabId = "context" | "conversation" | "request" | "response" | "stream";
type JsonMode = "formatted" | "raw";

type TraceTabModes = Partial<Record<TabId, JsonMode>>;
type NavMode = "sessions" | "traces";
type TraceEventPayload = {
  trace?: TraceRecord;
  traceId?: string | null;
  type?: string;
};

type TraceFilterIntent = {
  kind?: string;
  status?: string;
  tag?: [string, string];
};

type HierarchyTimelineRow = {
  ancestorContinuations: boolean[];
  badge: string;
  costUsd: number | null;
  depth: number;
  durationMs: number;
  hasHighlights: boolean;
  hasStructuredInput: boolean;
  hasVisibleChildren: boolean;
  id: string;
  isActive: boolean;
  isDetailTrace: boolean;
  isInPath: boolean;
  isLastSibling: boolean;
  label: string;
  meta: string;
  offsetMs: number;
  startedAt: string;
  type: string;
};

type HierarchyTimelineModel = {
  costUsd: number | null;
  durationMs: number;
  rows: HierarchyTimelineRow[];
  sessionLabel: string;
  startedAt: string;
};

type MessageInsightMatches = {
  highlights: TraceInsights["highlights"];
  structuredInputs: TraceInsights["structuredInputs"];
};

const STATUS_OPTIONS = [
  { label: "All statuses", value: "" },
  { label: "Pending", value: "pending" },
  { label: "OK", value: "ok" },
  { label: "Error", value: "error" },
] as const;

const KIND_OPTIONS = [
  { label: "All kinds", value: "" },
  { label: "Actor", value: "actor" },
  { label: "Child actor", value: "child-actor" },
  { label: "Stage", value: "stage" },
  { label: "Guardrail", value: "guardrail" },
] as const;

const INITIAL_FILTERS: Filters = {
  kind: "",
  search: "",
  status: "",
  tags: "",
};

export function App() {
  const [filters, setFilters] = useState<Filters>(INITIAL_FILTERS);
  const [data, setData] = useState<{
    hierarchy: HierarchyPayload;
    traces: TraceListPayload;
  }>({
    hierarchy: { filtered: 0, rootNodes: [], total: 0 },
    traces: { filtered: 0, items: [], total: 0 },
  });
  const [navMode, setNavMode] = useState<NavMode>("sessions");
  const [theme, setTheme] = useState<ThemeMode>(() => resolvePreferredTheme());
  const [eventsConnected, setEventsConnected] = useState(false);
  const [expandedNodeOverrides, setExpandedNodeOverrides] = useState<
    Record<string, boolean>
  >({});
  const [collapsedTraceGroups, setCollapsedTraceGroups] = useState<
    Record<string, boolean>
  >({});
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TraceRecord | null>(null);
  const [detailTab, setDetailTab] = useState<TabId>("conversation");
  const [confirmClear, setConfirmClear] = useState(false);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [isSessionsPanelCollapsed, setIsSessionsPanelCollapsed] =
    useState(false);
  const [tabModes, setTabModes] = useState<TraceTabModes>({});
  const [allSessionCount, setAllSessionCount] = useState(0);
  const detailRequestRef = useRef(0);
  const clearConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dataVersionRef = useRef(0);

  const deferredSearch = useDeferredValue(filters.search);
  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (deferredSearch) {
      params.set("search", deferredSearch);
    }
    if (filters.tags) {
      params.set("tags", filters.tags);
    }
    if (filters.status) {
      params.set("status", filters.status);
    }
    if (filters.kind) {
      params.set("kind", filters.kind);
    }
    return params.toString();
  }, [deferredSearch, filters.kind, filters.status, filters.tags]);

  const refreshData = useEffectEvent(async () => {
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }

    refreshInFlightRef.current = true;
    const requestVersion = dataVersionRef.current;
    const suffix = queryString ? `?${queryString}` : "";
    try {
      const [tracesRes, hierarchyRes, allHierarchyRes] = await Promise.all([
        fetch(`/api/traces${suffix}`),
        fetch(`/api/hierarchy${suffix}`),
        queryString ? fetch("/api/hierarchy") : Promise.resolve(null),
      ]);
      const [tracesPayload, hierarchy, allHierarchy] = (await Promise.all([
        tracesRes.json(),
        hierarchyRes.json(),
        allHierarchyRes ? allHierarchyRes.json() : Promise.resolve(null),
      ])) as [TraceListPayload, HierarchyPayload, HierarchyPayload | null];
      const traces = normalizeTraceListPayload(tracesPayload);
      const nextAllSessionCount = countSessionNodes(
        allHierarchy?.rootNodes ?? hierarchy.rootNodes,
      );

      if (dataVersionRef.current !== requestVersion) {
        refreshQueuedRef.current = true;
        return;
      }

      startTransition(() => {
        setData({ traces, hierarchy });
        setAllSessionCount(nextAllSessionCount);
        setSelectedSessionId(
          (current) => current ?? hierarchy.rootNodes[0]?.id ?? null,
        );
      });
    } finally {
      refreshInFlightRef.current = false;
      if (refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        void refreshData();
      }
    }
  });

  const scheduleRefresh = useEffectEvent((delayMs = 120) => {
    if (refreshTimerRef.current !== null) {
      return;
    }

    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void refreshData();
    }, delayMs);
  });

  useEffect(() => {
    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    void refreshData();
  }, [queryString]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
      if (clearConfirmTimerRef.current !== null) {
        clearTimeout(clearConfirmTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const applyIncrementalTraceUpdate = useEffectEvent(
    (nextTrace: TraceRecord) => {
      dataVersionRef.current += 1;
      startTransition(() => {
        setData((current) => {
          const nextSummary = toTraceSummary(nextTrace);
          const previousSummary =
            current.traces.items.find((item) => item.id === nextTrace.id) ??
            null;

          return {
            traces: {
              ...current.traces,
              items: replaceTraceSummary(current.traces.items, nextSummary),
            },
            hierarchy: {
              ...current.hierarchy,
              rootNodes: patchHierarchyForTraceUpdate(
                current.hierarchy.rootNodes,
                nextTrace.id,
                previousSummary,
                nextSummary,
              ),
            },
          };
        });
      });
    },
  );

  const applyIncrementalTraceAdd = useEffectEvent((nextTrace: TraceRecord) => {
    dataVersionRef.current += 1;
    startTransition(() => {
      setData((current) => {
        const nextSummary = toTraceSummary(nextTrace);
        const alreadyExists = current.traces.items.some(
          (item) => item.id === nextSummary.id,
        );
        return {
          ...current,
          traces: {
            ...current.traces,
            total: alreadyExists
              ? current.traces.total
              : current.traces.total + 1,
            filtered: alreadyExists
              ? current.traces.filtered
              : current.traces.filtered + 1,
            items: alreadyExists
              ? replaceTraceSummary(current.traces.items, nextSummary)
              : [nextSummary, ...current.traces.items],
          },
        };
      });
    });
  });

  const applyIncrementalTraceEvict = useEffectEvent(
    (traceId: string | null | undefined) => {
      if (!traceId) {
        return;
      }

      dataVersionRef.current += 1;
      startTransition(() => {
        setData((current) => {
          const nextItems = current.traces.items.filter(
            (item) => item.id !== traceId,
          );
          const removed = nextItems.length !== current.traces.items.length;

          return {
            ...current,
            traces: {
              ...current.traces,
              total: removed
                ? Math.max(0, current.traces.total - 1)
                : current.traces.total,
              filtered: nextItems.length,
              items: nextItems,
            },
          };
        });
      });
    },
  );

  const clearIncrementalState = useEffectEvent(() => {
    dataVersionRef.current += 1;
    startTransition(() => {
      setData({
        hierarchy: { filtered: 0, rootNodes: [], total: 0 },
        traces: { filtered: 0, items: [], total: 0 },
      });
      setAllSessionCount(0);
      setSelectedSessionId(null);
      setSelectedNodeId(null);
      setSelectedTraceId(null);
      setDetail(null);
    });
  });

  const handleSseMessage = useEffectEvent((data: string) => {
    const payload = parseEvent(data);
    if (payload?.type === "ui:reload") {
      window.location.reload();
      return;
    }

    if (
      payload?.trace &&
      selectedTraceId &&
      payload.traceId === selectedTraceId
    ) {
      startTransition(() => setDetail(payload.trace as TraceRecord));
    }

    if (!queryString) {
      if (payload?.type === "trace:update" && payload.trace) {
        applyIncrementalTraceUpdate(payload.trace);
        return;
      }

      if (payload?.type === "trace:add" && payload.trace) {
        applyIncrementalTraceAdd(payload.trace);
        scheduleRefresh(180);
        return;
      }

      if (payload?.type === "trace:evict") {
        applyIncrementalTraceEvict(payload.traceId);
        scheduleRefresh(180);
        return;
      }

      if (payload?.type === "trace:clear") {
        clearIncrementalState();
        return;
      }
    }

    scheduleRefresh(payload?.type === "trace:update" ? 700 : 180);
  });

  useEffect(() => {
    const events = new EventSource("/api/events");
    events.onopen = () => {
      startTransition(() => setEventsConnected(true));
    };
    events.onerror = () => {
      startTransition(() => setEventsConnected(false));
    };
    events.onmessage = (message) => {
      handleSseMessage(message.data);
    };
    return () => events.close();
  }, []);

  const traceById = useMemo(
    () => new Map(data.traces.items.map((item) => [item.id, item])),
    [data.traces.items],
  );
  const traceItems = useMemo(() => data.traces.items, [data.traces.items]);
  const navigatorMaxDurationMs = useMemo(
    () => getMaxDurationMs(traceItems),
    [traceItems],
  );
  const traceGroups = useMemo(
    () => groupTracesForNav(traceItems),
    [traceItems],
  );
  const sessionNodes = useMemo(
    () => data.hierarchy.rootNodes.filter((node) => node.type === "session"),
    [data.hierarchy.rootNodes],
  );
  const sessionNodeById = useMemo(
    () => new Map(sessionNodes.map((node) => [node.id, node])),
    [sessionNodes],
  );
  const sessionNavItems = useMemo(
    () => deriveSessionNavItems(sessionNodes, traceById),
    [sessionNodes, traceById],
  );
  const hasActiveFilters = Boolean(
    filters.search || filters.status || filters.kind || filters.tags,
  );
  const filteredSessionCount = sessionNavItems.length;
  const hasRecordedSessions = allSessionCount > 0;
  const showFilteredSessionEmptyState =
    hasActiveFilters && hasRecordedSessions && filteredSessionCount === 0;
  const selectedSessionNode = useMemo(
    () =>
      selectedSessionId
        ? (sessionNodeById.get(selectedSessionId) ?? null)
        : ((sessionNavItems[0] &&
            sessionNodeById.get(sessionNavItems[0].id)) ??
          null),
    [selectedSessionId, sessionNavItems, sessionNodeById],
  );
  const selectedTraceSummary = useMemo(
    () => (selectedTraceId ? (traceById.get(selectedTraceId) ?? null) : null),
    [selectedTraceId, traceById],
  );

  useEffect(() => {
    if (
      !selectedSessionId ||
      !sessionNodeById.has(selectedSessionId)
    ) {
      startTransition(() =>
        setSelectedSessionId(sessionNavItems[0]?.id ?? null),
      );
    }
  }, [selectedSessionId, sessionNavItems, sessionNodeById]);

  useEffect(() => {
    if (navMode !== "sessions") {
      return;
    }

    const currentSelectedNode =
      selectedNodeId && selectedSessionNode
        ? findNodeById([selectedSessionNode], selectedNodeId)
        : null;
    const fallbackTraceId = getNewestTraceId(selectedSessionNode);
    const fallbackNodeId =
      currentSelectedNode?.id ??
      (fallbackTraceId
        ? toTraceNodeId(fallbackTraceId)
        : (selectedSessionNode?.id ?? null));
    if (fallbackNodeId !== selectedNodeId) {
      startTransition(() => setSelectedNodeId(fallbackNodeId));
    }
  }, [navMode, selectedNodeId, selectedSessionNode]);

  useEffect(() => {
    const hasSelectedTrace = selectedTraceId
      ? traceItems.some((trace) => trace.id === selectedTraceId)
      : false;

    if (navMode === "traces") {
      if (!hasSelectedTrace) {
        startTransition(() => setSelectedTraceId(traceItems[0]?.id ?? null));
      }
      return;
    }

    const fallbackNode =
      (selectedNodeId
        ? findNodeById(data.hierarchy.rootNodes, selectedNodeId)
        : null) ?? selectedSessionNode;
    const nextTraceId = hasSelectedTrace
      ? selectedTraceId
      : getNewestTraceId(fallbackNode);
    if (nextTraceId !== selectedTraceId) {
      startTransition(() => setSelectedTraceId(nextTraceId));
    }
  }, [
    data.hierarchy.rootNodes,
    navMode,
    selectedNodeId,
    selectedSessionNode,
    selectedTraceId,
    traceItems,
  ]);

  const loadDetail = useEffectEvent(async (traceId: string | null) => {
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;

    if (!traceId) {
      startTransition(() => setDetail(null));
      return;
    }

    const res = await fetch(`/api/traces/${encodeURIComponent(traceId)}`);
    if (detailRequestRef.current !== requestId) {
      return;
    }

    if (!res.ok) {
      startTransition(() => setDetail(null));
      return;
    }

    const payload = (await res.json()) as TraceRecord;
    if (detailRequestRef.current !== requestId) {
      return;
    }

    applyIncrementalTraceUpdate(payload);
    startTransition(() => setDetail(payload));
  });

  useEffect(() => {
    void loadDetail(selectedTraceId);
  }, [selectedTraceId]);

  const defaultExpandedNodeIds = useMemo(
    () => getDefaultExpandedNodeIds(data.hierarchy.rootNodes),
    [data.hierarchy.rootNodes],
  );
  const selectedNodePath = useMemo(
    () =>
      selectedNodeId
        ? findNodePath(data.hierarchy.rootNodes, selectedNodeId)
        : [],
    [data.hierarchy.rootNodes, selectedNodeId],
  );
  const selectedTimelineModel = useMemo(
    () =>
      buildHierarchyTimelineModel(
        selectedSessionNode,
        traceById,
        selectedNodeId,
        selectedNodePath,
        selectedTraceId,
      ),
    [
      selectedNodeId,
      selectedNodePath,
      selectedSessionNode,
      selectedTraceId,
      traceById,
    ],
  );

  useEffect(() => {
    if (!selectedNodePath.length) {
      return;
    }

    startTransition(() => {
      setExpandedNodeOverrides((current) => {
        const next = { ...current };
        for (const node of selectedNodePath.slice(0, -1)) {
          next[node.id] = true;
        }
        return next;
      });
    });
  }, [selectedNodePath]);

  const activeTabJsonMode = tabModes[detailTab] ?? "formatted";
  const activeTagFilterCount = countTagFilters(filters.tags);

  const onFilterChange = (key: keyof Filters, value: string) => {
    startTransition(() => {
      setFilters((current) => ({ ...current, [key]: value }));
    });
  };

  const applyTagFilter = (key: string, value: string) => {
    const nextEntry = `${key}:${value}`;
    startTransition(() => {
      setFilters((current) => ({
        ...current,
        tags: mergeTagFilter(current.tags, nextEntry),
      }));
      setShowAdvancedFilters(true);
    });
  };

  const applyTraceFilter = (intent: TraceFilterIntent) => {
    startTransition(() => {
      setFilters((current) => ({
        ...current,
        kind: intent.kind ?? current.kind,
        status: intent.status ?? current.status,
        tags: intent.tag
          ? mergeTagFilter(current.tags, `${intent.tag[0]}:${intent.tag[1]}`)
          : current.tags,
      }));
      if (intent.tag) {
        setShowAdvancedFilters(true);
      }
    });
  };

  const toggleNodeExpansion = (nodeId: string) => {
    startTransition(() => {
      setExpandedNodeOverrides((current) => ({
        ...current,
        [nodeId]: !(current[nodeId] ?? defaultExpandedNodeIds.has(nodeId)),
      }));
    });
  };

  const toggleTraceGroupCollapse = (groupId: string) => {
    startTransition(() => {
      setCollapsedTraceGroups((current) => ({
        ...current,
        [groupId]: !current[groupId],
      }));
    });
  };

  const resetFilters = () => {
    const nextSessionNode =
      (sessionNavItems[0] && sessionNodeById.get(sessionNavItems[0].id)) ??
      null;
    startTransition(() => {
      setFilters(INITIAL_FILTERS);
      setShowAdvancedFilters(false);
      setSelectedSessionId(nextSessionNode?.id ?? null);
      setSelectedNodeId(nextSessionNode?.id ?? null);
      setSelectedTraceId(
        navMode === "traces"
          ? (traceItems[0]?.id ?? null)
          : getNewestTraceId(nextSessionNode),
      );
    });
  };

  const clearTraces = async () => {
    if (clearConfirmTimerRef.current !== null) {
      clearTimeout(clearConfirmTimerRef.current);
      clearConfirmTimerRef.current = null;
    }
    startTransition(() => setConfirmClear(false));
    await fetch("/api/traces", { method: "DELETE" });
    await refreshData();
  };

  const handleClearTraces = () => {
    if (confirmClear) {
      void clearTraces();
      return;
    }

    if (clearConfirmTimerRef.current !== null) {
      clearTimeout(clearConfirmTimerRef.current);
    }

    startTransition(() => setConfirmClear(true));
    clearConfirmTimerRef.current = setTimeout(() => {
      clearConfirmTimerRef.current = null;
      startTransition(() => setConfirmClear(false));
    }, 2500);
  };

  const handleThemeChange = (nextTheme: ThemeMode) => {
    startTransition(() => setTheme(nextTheme));
  };

  const toggleSessionsPanel = () => {
    startTransition(() =>
      setIsSessionsPanelCollapsed((current) => !current),
    );
  };

  const showSessionsMode = () => {
    const tracePath = selectedTraceId
      ? findNodePath(data.hierarchy.rootNodes, `trace:${selectedTraceId}`)
      : [];
    const fallbackSessionNode =
      tracePath[0] ??
      selectedSessionNode ??
      ((sessionNavItems[0] && sessionNodeById.get(sessionNavItems[0].id)) ??
        null);
    const fallbackNodeId =
      tracePath[tracePath.length - 1]?.id ??
      selectedNodeId ??
      fallbackSessionNode?.id ??
      null;
    const nextTraceId =
      selectedTraceId && traceById.has(selectedTraceId)
        ? selectedTraceId
        : getNewestTraceId(fallbackSessionNode);

    startTransition(() => {
      setNavMode("sessions");
      setSelectedSessionId(fallbackSessionNode?.id ?? null);
      setSelectedNodeId(fallbackNodeId);
      setSelectedTraceId(nextTraceId);
      setDetailTab("conversation");
    });
  };

  const showTracesMode = () => {
    startTransition(() => {
      const nextTraceId =
        selectedTraceId &&
        traceItems.some((trace) => trace.id === selectedTraceId)
          ? selectedTraceId
          : (traceItems[0]?.id ?? null);
      setNavMode("traces");
      setSelectedTraceId(nextTraceId);
      setSelectedNodeId(nextTraceId ? `trace:${nextTraceId}` : selectedNodeId);
      setDetailTab("conversation");
      if (nextTraceId) {
        const nextTrace = traceById.get(nextTraceId);
        if (nextTrace?.hierarchy.sessionId) {
          setSelectedSessionId(toSessionNodeId(nextTrace.hierarchy.sessionId));
        }
      }
    });
  };

  const selectTraceFromList = (traceId: string) => {
    const trace = traceById.get(traceId);
    startTransition(() => {
      setNavMode("traces");
      setSelectedTraceId(traceId);
      setSelectedNodeId(`trace:${traceId}`);
      setDetailTab("conversation");
      if (trace?.hierarchy.sessionId) {
        setSelectedSessionId(toSessionNodeId(trace.hierarchy.sessionId));
      }
    });
  };

  const handleHierarchySelect = (node: HierarchyNode) => {
    const nodePath = findNodePath(data.hierarchy.rootNodes, node.id);
    const nextTraceId =
      node.type === "trace"
        ? (node.meta.traceId ?? node.traceIds[0] ?? null)
        : getNewestTraceId(node);
    const nextSessionId =
      nodePath[0]?.type === "session" ? nodePath[0].id : selectedSessionId;
    const nextSelectedNodeId =
      node.type === "trace"
        ? node.id
        : nextTraceId
          ? toTraceNodeId(nextTraceId)
          : node.id;

    startTransition(() => {
      setNavMode("sessions");
      setSelectedSessionId(nextSessionId ?? null);
      setSelectedNodeId(nextSelectedNodeId);
      setSelectedTraceId(nextTraceId);
      setDetailTab("conversation");
    });
  };

  const handleTimelineSelect = (nodeId: string) => {
    const scopeNodes = selectedSessionNode
      ? [selectedSessionNode]
      : data.hierarchy.rootNodes;
    const node =
      findNodeById(scopeNodes, nodeId) ??
      findNodeById(data.hierarchy.rootNodes, nodeId);
    if (!node) {
      return;
    }

    handleHierarchySelect(node);
  };

  const navigateToHierarchyNode = (nodeId: string) => {
    const node = findNodeById(data.hierarchy.rootNodes, nodeId);
    if (!node) {
      return;
    }

    const nodePath = findNodePath(data.hierarchy.rootNodes, nodeId);
    const nextSessionId =
      nodePath[0]?.type === "session" ? nodePath[0].id : selectedSessionId;
    const nextTraceId =
      selectedTraceId && node.traceIds.includes(selectedTraceId)
        ? selectedTraceId
        : getNewestTraceId(node);

    startTransition(() => {
      setNavMode("sessions");
      setSelectedSessionId(nextSessionId ?? null);
      setSelectedNodeId(nodeId);
      if (nextTraceId !== selectedTraceId) {
        setSelectedTraceId(nextTraceId);
      }
    });
  };

  const detailTabs = buildDetailTabs(detail);
  const activeTab = detailTabs.some((tab) => tab.id === detailTab)
    ? detailTab
    : (detailTabs[0]?.id ?? "conversation");

  const handleSessionChange = (sessionId: string) => {
    const sessionNode = sessionNodeById.get(sessionId) ?? null;
    const nextTraceId = getNewestTraceId(sessionNode);

    startTransition(() => {
      setNavMode("sessions");
      setSelectedSessionId(sessionId);
      setSelectedNodeId(nextTraceId ? toTraceNodeId(nextTraceId) : sessionId);
      setSelectedTraceId(nextTraceId);
      setDetailTab("conversation");
    });
  };

  return (
    <div className="app-shell">
      <BackgroundGlow />
      <div className="app-frame">
        <div className="board-shell inspector-shell">
          <div className="inspector-header">
            <div className="brand-mark">
              <BrandLogo />
              <div className="brand-copy">
                <BrandWordmark />
                <span className="brand-subtitle">{BRAND_SUBTITLE}</span>
              </div>
            </div>

            <div className="inspector-header-side">
              <div className="inspector-status">
                <span className="inspector-chip">Local dev</span>
                <span
                  className={cn(
                    "inspector-live-status",
                    eventsConnected && "is-live",
                  )}
                >
                  <span className="inspector-live-dot" aria-hidden="true" />
                  {eventsConnected ? "Connected" : "Reconnecting"}
                </span>
              </div>
              <div className="inspector-header-actions">
                <Button
                  variant="outline"
                  className={cn(
                    "clear-traces-button",
                    confirmClear && "is-confirming",
                  )}
                  onClick={handleClearTraces}
                >
                  {confirmClear ? "Confirm clear" : "Clear traces"}
                </Button>
                <ThemeSwitcher theme={theme} onChange={handleThemeChange} />
              </div>
            </div>
          </div>

          <Card className="toolbar-card">
            <CardContent className="toolbar-content">
              <div className="filters-grid inspector-filters-grid">
                <FilterField
                  icon={Search}
                  label="Search"
                  value={filters.search}
                  onChange={(value) => onFilterChange("search", value)}
                  placeholder="Search prompts, responses, tags"
                />
                <SelectField
                  label="Status"
                  value={filters.status}
                  onChange={(value) => onFilterChange("status", value)}
                  options={STATUS_OPTIONS}
                />
                <SelectField
                  label="Kind"
                  value={filters.kind}
                  onChange={(value) => onFilterChange("kind", value)}
                  options={KIND_OPTIONS}
                />
                <div className="toolbar-actions">
                  <Button
                    variant="outline"
                    className={cn(
                      "session-panel-toggle",
                      isSessionsPanelCollapsed && "is-active",
                    )}
                    onClick={toggleSessionsPanel}
                  >
                    {isSessionsPanelCollapsed ? "Show sessions" : "Hide sessions"}
                  </Button>
                  <Button
                    variant="outline"
                    className={cn(
                      "tag-filter-toggle",
                      (showAdvancedFilters || activeTagFilterCount > 0) &&
                        "is-active",
                    )}
                    onClick={() =>
                      setShowAdvancedFilters((current) => !current)
                    }
                  >
                    <Filter data-icon="inline-start" />
                    {showAdvancedFilters || filters.tags
                      ? "Hide tag filters"
                      : activeTagFilterCount > 0
                        ? `Tag filters · ${activeTagFilterCount}`
                        : "Tag filters"}
                  </Button>
                  {hasActiveFilters ? (
                    <Button variant="outline" onClick={resetFilters}>
                      <X data-icon="inline-start" />
                      Clear filters
                    </Button>
                  ) : null}
                </div>
              </div>

              {showAdvancedFilters || filters.tags ? (
                <div className="filters-secondary-row">
                  <FilterField
                    icon={Bot}
                    label="Tag filter"
                    value={filters.tags}
                    onChange={(value) => onFilterChange("tags", value)}
                    placeholder="actorId:assistant,kind:guardrail"
                  />
                </div>
              ) : null}
            </CardContent>
          </Card>

          <div
            className={cn(
              "workspace-grid",
              isSessionsPanelCollapsed && "is-sidebar-collapsed",
            )}
          >
            <Card className="sidebar-card session-sidebar-card inspector-card">
              <div className="session-sidebar-shell">
                {sessionNavItems.length || hasActiveFilters || hasRecordedSessions ? (
                  <SessionNavList
                    hasActiveFilters={hasActiveFilters}
                    items={sessionNavItems}
                    onChange={handleSessionChange}
                    totalCount={allSessionCount}
                    selectedId={selectedSessionNode?.id ?? null}
                  />
                ) : null}

                {selectedTimelineModel ? (
                  <HierarchyTimelineOverview
                    axisStops={COMPACT_TIMELINE_AXIS_STOPS}
                    model={selectedTimelineModel}
                    onSelectRow={handleTimelineSelect}
                  />
                ) : (
                  <div className="session-sidebar-empty">
                    {showFilteredSessionEmptyState ? (
                      <div className="session-sidebar-empty-state">
                        <EmptyState
                          icon={Filter}
                          title="No sessions match the current filters"
                          description="Try adjusting the search, status, kind, or tag filters to broaden the result set."
                        />
                        <Button variant="outline" onClick={resetFilters}>
                          <X data-icon="inline-start" />
                          Clear filters
                        </Button>
                      </div>
                    ) : (
                      <EmptyState
                        icon={Network}
                        title="No sessions yet"
                        description="Trigger any traced LLM call and the session timeline will appear here."
                      />
                    )}
                  </div>
                )}
              </div>
            </Card>

            <Card className="timeline-card content-card inspector-card">
              {selectedTraceId ? (
                <TraceDetailPanel
                  activeTab={activeTab}
                  detail={detail}
                  detailTabs={detailTabs}
                  fallbackTrace={selectedTraceSummary}
                  jsonMode={activeTabJsonMode}
                  onApplyTagFilter={applyTagFilter}
                  onApplyTraceFilter={applyTraceFilter}
                  onNavigateHierarchyNode={navigateToHierarchyNode}
                  onTabChange={(value) => setDetailTab(value as TabId)}
                  onSelectTimelineNode={handleTimelineSelect}
                  onToggleJsonMode={(tabId) =>
                    startTransition(() => {
                      setTabModes((current) => ({
                        ...current,
                        [tabId]:
                          (current[tabId] ?? "formatted") === "formatted"
                            ? "raw"
                            : "formatted",
                      }));
                    })
                  }
                  timelineModel={null}
                />
              ) : (
                <CardContent className="content-scroll">
                  <EmptyState
                    icon={ArrowUpRight}
                    title="Select a trace from the session timeline"
                    description="Choose any call on the left to inspect the full request, response, context, and stream details."
                  />
                </CardContent>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

function BrandLogo() {
  return (
    <div className="brand-logo" aria-hidden="true">
      <svg viewBox={BRAND_MARK_VIEWBOX} className="brand-logo-svg">
        {BRAND_MARK_PATHS.map((path, index) => (
          <path key={index} d={path} fill="currentColor" />
        ))}
      </svg>
    </div>
  );
}

function BrandWordmark() {
  return (
    <div className="brand-wordmark" role="img" aria-label={BRAND_NAME}>
      <span className="brand-wordmark-text" aria-hidden="true">
        {BRAND_NAME}
      </span>
    </div>
  );
}

function ThemeSwitcher({
  onChange,
  theme,
}: {
  onChange: (theme: ThemeMode) => void;
  theme: ThemeMode;
}) {
  return (
    <div className="theme-switch" role="group" aria-label="Color theme">
      <button
        type="button"
        className={cn("theme-switch-button", theme === "light" && "is-active")}
        aria-pressed={theme === "light"}
        aria-label="Use light theme"
        title="Light theme"
        onClick={() => onChange("light")}
      >
        <Sun data-icon="inline-start" />
        <span className="sr-only">Light theme</span>
      </button>
      <button
        type="button"
        className={cn("theme-switch-button", theme === "dark" && "is-active")}
        aria-pressed={theme === "dark"}
        aria-label="Use dark theme"
        title="Dark theme"
        onClick={() => onChange("dark")}
      >
        <Moon data-icon="inline-start" />
        <span className="sr-only">Dark theme</span>
      </button>
    </div>
  );
}

function SessionNavList({
  hasActiveFilters,
  items,
  onChange,
  selectedId,
  totalCount,
}: {
  hasActiveFilters: boolean;
  items: SessionNavItem[];
  onChange: (sessionId: string) => void;
  selectedId: string | null;
  totalCount: number;
}) {
  const filteredCount = items.length;
  const countLabel =
    hasActiveFilters && totalCount > filteredCount
      ? `${filteredCount} of ${totalCount} sessions`
      : formatCountLabel(
          hasActiveFilters ? filteredCount : Math.max(filteredCount, totalCount),
          "session",
        );

  return (
    <div className="session-nav-section">
      <div className="session-nav-header">
        <div className="session-nav-title-row">
          <div className="session-nav-title">Sessions</div>
          {hasActiveFilters ? (
            <Badge variant="outline" className="session-nav-filter-badge">
              Filtered
            </Badge>
          ) : null}
        </div>
        <div className="session-nav-meta">
          {countLabel}
        </div>
      </div>
      <div className="session-nav-list" role="list" aria-label="Sessions">
        {items.map((item) => {
          const costLabel = formatUsdCost(item.costUsd);
          const detailLabel =
            formatList([formatCountLabel(item.callCount, "call"), costLabel]) ||
            formatCountLabel(item.callCount, "call");
          const badge = getSessionNavBadge(item);

          return (
            <button
              key={item.id}
              type="button"
              role="listitem"
              className={cn(
                "session-nav-card",
                item.id === selectedId && "is-active",
              )}
              aria-pressed={item.id === selectedId}
              onClick={() => onChange(item.id)}
            >
              <div className="session-nav-card-header">
                <div
                  className="session-nav-card-title"
                  title={item.primaryLabel}
                >
                  {item.primaryLabel}
                </div>
                {item.latestTimestamp ? (
                  <div className="session-nav-card-time">
                    {item.latestTimestamp}
                  </div>
                ) : null}
              </div>
              <div className="session-nav-card-meta">{detailLabel}</div>
              <div className="session-nav-card-footer">
                <div className="session-nav-card-id">{item.shortSessionId}</div>
                {badge}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function getSessionNavBadge(item: SessionNavItem): ReactNode {
  if (item.status === "error") {
    return <Badge variant="destructive">Error</Badge>;
  }

  if (item.status === "pending") {
    return <Badge variant="warning">Running</Badge>;
  }

  if (item.hasHighlights) {
    return (
      <Badge variant="secondary" semantic="guardrail">
        Insight
      </Badge>
    );
  }

  return null;
}

function BackgroundGlow() {
  return (
    <div className="background-glow" aria-hidden="true">
      <div className="glow glow-teal" />
      <div className="glow glow-coral" />
      <div className="grid-noise" />
    </div>
  );
}

function HierarchyTree({
  defaultExpandedNodeIds,
  expandedNodeOverrides,
  maxDurationMs,
  nodes,
  onSelect,
  onToggle,
  selectedNodeId,
  selectedTraceId,
  traceById,
}: {
  defaultExpandedNodeIds: Set<string>;
  expandedNodeOverrides: Record<string, boolean>;
  maxDurationMs: number;
  nodes: HierarchyNode[];
  onSelect: (node: HierarchyNode) => void;
  onToggle: (id: string) => void;
  selectedNodeId: string | null;
  selectedTraceId: string | null;
  traceById: Map<string, TraceSummary>;
}) {
  return (
    <div className="tree-root">
      {nodes.map((node) => (
        <HierarchyTreeNode
          key={node.id}
          defaultExpandedNodeIds={defaultExpandedNodeIds}
          depth={0}
          expandedNodeOverrides={expandedNodeOverrides}
          maxDurationMs={maxDurationMs}
          node={node}
          onSelect={onSelect}
          onToggle={onToggle}
          selectedNodeId={selectedNodeId}
          selectedTraceId={selectedTraceId}
          traceById={traceById}
        />
      ))}
    </div>
  );
}

function HierarchyTreeNode({
  defaultExpandedNodeIds,
  depth,
  expandedNodeOverrides,
  maxDurationMs,
  node,
  onSelect,
  onToggle,
  selectedNodeId,
  selectedTraceId,
  traceById,
}: {
  defaultExpandedNodeIds: Set<string>;
  depth: number;
  expandedNodeOverrides: Record<string, boolean>;
  maxDurationMs: number;
  node: HierarchyNode;
  onSelect: (node: HierarchyNode) => void;
  onToggle: (id: string) => void;
  selectedNodeId: string | null;
  selectedTraceId: string | null;
  traceById: Map<string, TraceSummary>;
}) {
  const isExpandable = node.children.length > 0;
  const isExpanded =
    isExpandable &&
    (expandedNodeOverrides[node.id] ?? defaultExpandedNodeIds.has(node.id));
  const nodeCopy = getHierarchyNodeCopy(node, traceById);
  const trace = node.meta.traceId
    ? (traceById.get(node.meta.traceId) ?? null)
    : null;

  if (node.type === "trace" && trace) {
    return (
      <TraceHierarchyLeaf
        depth={depth}
        maxDurationMs={maxDurationMs}
        node={node}
        nodeCopy={nodeCopy}
        onSelect={onSelect}
        selected={selectedNodeId === node.id}
        selectedTrace={selectedTraceId === trace.id}
        trace={trace}
      />
    );
  }

  return (
    <div
      className="tree-node-wrap"
      style={{ "--depth": String(depth) } as CSSProperties}
    >
      <div
        className={clsx(
          "tree-node-card",
          selectedNodeId === node.id && "is-active",
          node.type === "trace" && "is-trace",
        )}
      >
        <button
          type="button"
          className={clsx("tree-node-toggle", !isExpandable && "is-static")}
          disabled={!isExpandable}
          onClick={() => {
            if (isExpandable) {
              onToggle(node.id);
            }
          }}
          aria-label={
            isExpandable
              ? `${isExpanded ? "Collapse" : "Expand"} ${nodeCopy.label}`
              : undefined
          }
        >
          <ChevronRight className={clsx(isExpanded && "is-open")} />
        </button>
        <button
          type="button"
          className="tree-node-select"
          onClick={() => onSelect(node)}
        >
          <span className="tree-node-copy">
            <span className="tree-node-label">{nodeCopy.label}</span>
            <span className="tree-node-meta">{nodeCopy.meta}</span>
          </span>
        </button>
        <Badge variant="secondary" semantic={nodeCopy.badge}>
          {nodeCopy.badge}
        </Badge>
      </div>
      {isExpanded ? (
        <div className="tree-node-children">
          {node.children.map((child) => (
            <HierarchyTreeNode
              key={child.id}
              defaultExpandedNodeIds={defaultExpandedNodeIds}
              depth={depth + 1}
              expandedNodeOverrides={expandedNodeOverrides}
              maxDurationMs={maxDurationMs}
              node={child}
              onSelect={onSelect}
              onToggle={onToggle}
              selectedNodeId={selectedNodeId}
              selectedTraceId={selectedTraceId}
              traceById={traceById}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TraceNavigatorItem({
  maxDurationMs,
  onClick,
  selected,
  trace,
}: {
  maxDurationMs: number;
  onClick: () => void;
  selected: boolean;
  trace: TraceSummary;
}) {
  const copy = getTraceDisplayCopy(trace);
  const traceCostLabel = formatUsdCost(trace.costUsd);

  return (
    <button
      type="button"
      className={cn("nav-item trace-nav-item", selected && "is-active")}
      onClick={onClick}
    >
      <div className="nav-item-copy">
        <div className="trace-nav-kicker">{getTraceActorLabel(trace)}</div>
        <div className="nav-item-title">{copy.title}</div>
        <div className="trace-nav-meta-row">
          <span>{formatTimelineTimestamp(trace.startedAt)}</span>
          <span>
            {formatList([trace.provider, trace.model]) || "Unknown model"}
          </span>
        </div>
      </div>
      <div className="nav-item-side">
        <TraceElapsedBar
          durationMs={trace.durationMs}
          maxDurationMs={maxDurationMs}
        />
        <div className="nav-item-side-meta">
          {traceCostLabel ? (
            <TraceMetricPill tone="cost">{traceCostLabel}</TraceMetricPill>
          ) : null}
          <StatusBadge status={trace.status} />
        </div>
      </div>
    </button>
  );
}

function TraceHierarchyLeaf({
  depth,
  maxDurationMs,
  node,
  nodeCopy,
  onSelect,
  selected,
  selectedTrace,
  trace,
}: {
  depth: number;
  maxDurationMs: number;
  node: HierarchyNode;
  nodeCopy: { badge: string; label: string; meta: string };
  onSelect: (node: HierarchyNode) => void;
  selected: boolean;
  selectedTrace: boolean;
  trace: TraceSummary;
}) {
  return (
    <div
      className="tree-node-wrap tree-trace-wrap"
      style={{ "--depth": String(depth) } as CSSProperties}
    >
      <div
        className={clsx(
          "tree-node-card is-trace",
          selected && "is-active",
          selectedTrace && "is-detail-trace",
        )}
      >
        <button
          type="button"
          className="tree-node-select tree-trace-select"
          onClick={() => onSelect(node)}
        >
          <span className="tree-node-copy">
            <span className="trace-nav-kicker">
              {getTraceActorLabel(trace)}
            </span>
            <span className="tree-node-label">{nodeCopy.label}</span>
            <span className="tree-node-meta">
              {formatList([
                formatTimelineTimestamp(trace.startedAt),
                nodeCopy.meta,
              ])}
            </span>
          </span>
          <TraceElapsedBar
            compact
            durationMs={trace.durationMs}
            maxDurationMs={maxDurationMs}
          />
        </button>
      </div>
    </div>
  );
}

function StatusBadge({
  status,
  onClick,
}: {
  status: TraceSummary["status"];
  onClick?: () => void;
}) {
  const variant =
    status === "error"
      ? "destructive"
      : status === "pending"
        ? "warning"
        : "success";
  if (onClick) {
    return (
      <BadgeButton variant={variant} onClick={onClick}>
        {status}
      </BadgeButton>
    );
  }

  return <Badge variant={variant}>{status}</Badge>;
}

function TraceMetricPill({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "cost" | "default" | "latency";
}) {
  return (
    <span
      className={cn("trace-metric-pill", tone !== "default" && `is-${tone}`)}
    >
      {children}
    </span>
  );
}

function TraceElapsedBar({
  compact = false,
  durationMs,
  maxDurationMs,
}: {
  compact?: boolean;
  durationMs: number | null;
  maxDurationMs: number;
}) {
  const durationLabel = formatElapsedLabel(durationMs);
  const scale = getElapsedScale(durationMs, maxDurationMs);

  return (
    <div
      className={cn(
        "trace-elapsed-bar",
        compact && "is-compact",
        durationMs === null && "is-pending",
      )}
      style={{ "--elapsed-scale": String(scale) } as CSSProperties}
    >
      <span className="trace-elapsed-track" aria-hidden="true">
        <span className="trace-elapsed-span" />
      </span>
      <span className="trace-elapsed-label">{durationLabel}</span>
    </div>
  );
}

function HierarchyTimelineOverview({
  axisStops = TIMELINE_AXIS_STOPS,
  model,
  onSelectRow,
}: {
  axisStops?: number[];
  model: HierarchyTimelineModel;
  onSelectRow: (nodeId: string) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const hasInitializedScrollRef = useRef(false);
  const totalCostLabel = formatCostSummaryLabel(
    model.costUsd,
    model.rows.length > 1,
  );
  const hasTraceRows = model.rows.some((row) => row.type === "trace");
  const activeRowId =
    model.rows.find((row) => row.isActive)?.id ??
    model.rows.find((row) => row.isDetailTrace)?.id ??
    null;

  useEffect(() => {
    if (!activeRowId || !listRef.current) {
      return;
    }

    if (!hasInitializedScrollRef.current) {
      hasInitializedScrollRef.current = true;
      return;
    }

    const list = listRef.current;
    const target = [...list.querySelectorAll<HTMLElement>(
      "[data-hierarchy-row-id]",
    )].find((element) => element.dataset.hierarchyRowId === activeRowId);
    if (!target) {
      return;
    }

    const viewportTop = list.scrollTop;
    const viewportBottom = viewportTop + list.clientHeight;
    const targetTop = target.offsetTop;
    const targetBottom = targetTop + target.offsetHeight;

    if (targetTop >= viewportTop && targetBottom <= viewportBottom) {
      return;
    }

    const contextOffset = Math.max(
      target.offsetHeight * 1.5,
      list.clientHeight * 0.35,
    );
    const nextTop = Math.max(0, targetTop - contextOffset);
    list.scrollTo({ top: nextTop });
  }, [activeRowId]);

  return (
    <div className="hierarchy-timeline-panel">
      <div className="hierarchy-timeline-header">
        <div>
          <div className="hierarchy-timeline-title">Session timeline</div>
          <div className="hierarchy-timeline-meta">
            <span>{model.sessionLabel}</span>
            <span>{formatTimelineTimestamp(model.startedAt)}</span>
          </div>
        </div>
        <div className="hierarchy-timeline-header-side">
          {totalCostLabel ? (
            <TraceMetricPill tone="cost">{totalCostLabel}</TraceMetricPill>
          ) : null}
          <TraceMetricPill tone="latency">
            {formatElapsedLabel(model.durationMs)}
          </TraceMetricPill>
        </div>
      </div>

      {hasTraceRows ? (
        <div className="hierarchy-timeline-hint">
          Click a call row to inspect it on the right.
        </div>
      ) : null}

      <div className="hierarchy-timeline-axis" aria-hidden="true">
        <div />
        <div />
        <div className="hierarchy-timeline-axis-track">
          {axisStops.map((stop) => (
            <span
              key={stop}
              className="hierarchy-timeline-axis-tick"
              style={
                { "--timeline-axis-offset": String(stop) } as CSSProperties
              }
            >
              <span className="hierarchy-timeline-axis-label">
                {formatElapsedLabel(model.durationMs * stop)}
              </span>
            </span>
          ))}
        </div>
      </div>

      <div
        ref={listRef}
        className="hierarchy-timeline-list"
        role="list"
        aria-label="Nested session timeline"
      >
        {model.rows.map((row) => {
          const isTraceRow = row.type === "trace";
          const rowClassName = cn(
            "hierarchy-timeline-row",
            isTraceRow ? "is-clickable" : "is-structure",
            row.depth === 0 && "is-root",
            row.isActive && "is-active",
            row.isDetailTrace && "is-detail-trace",
            row.isInPath && "is-in-path",
            `is-${row.type.replace(/[^a-z0-9-]/gi, "-")}`,
          );
          const rowStyle = {
            "--timeline-depth": String(row.depth),
            "--timeline-offset": String(
              model.durationMs > 0 ? row.offsetMs / model.durationMs : 0,
            ),
            "--timeline-span": String(
              model.durationMs > 0 ? row.durationMs / model.durationMs : 1,
            ),
          } as CSSProperties;
          const rowContent = (
            <Fragment>
              <div className="hierarchy-timeline-row-time">
                {formatTimelineTimestamp(row.startedAt)}
              </div>
              <div className="hierarchy-timeline-row-branch">
                <div
                  className="hierarchy-timeline-row-gutter"
                  aria-hidden="true"
                >
                  {row.ancestorContinuations.map((continues, index) => (
                    <span
                      key={`${row.id}-ancestor-${index}`}
                      className={cn(
                        "hierarchy-timeline-row-ancestor",
                        continues && "has-line",
                      )}
                      style={
                        {
                          "--timeline-connector-index": String(index),
                        } as CSSProperties
                      }
                    />
                  ))}
                  {row.depth > 0 ? (
                    <span
                      className="hierarchy-timeline-row-connector"
                      style={
                        {
                          "--timeline-connector-index": String(
                            row.depth - 1,
                          ),
                        } as CSSProperties
                      }
                    >
                      <span className="hierarchy-timeline-row-connector-top" />
                      <span className="hierarchy-timeline-row-connector-elbow" />
                      <span
                        className={cn(
                          "hierarchy-timeline-row-connector-bottom",
                          (row.hasVisibleChildren || !row.isLastSibling) &&
                            "has-line",
                        )}
                      />
                    </span>
                  ) : null}
                </div>
                <div className="hierarchy-timeline-row-labels">
                  <div className="hierarchy-timeline-row-title">
                    <span className="hierarchy-timeline-row-title-text">
                      {row.label}
                    </span>
                    <Badge
                      variant="secondary"
                      className="hierarchy-timeline-pill"
                      semantic={row.badge}
                    >
                      {row.badge}
                    </Badge>
                    {row.hasStructuredInput ? (
                      <span
                        className="hierarchy-timeline-row-flag"
                        title="Structured input detected for this call"
                      >
                        Structured input
                      </span>
                    ) : null}
                    {row.hasHighlights && !row.hasStructuredInput ? (
                      <span
                        className="hierarchy-timeline-row-flag is-highlight"
                        title="Trace insights available"
                      >
                        Insight
                      </span>
                    ) : null}
                  </div>
                  <div className="hierarchy-timeline-row-meta">{row.meta}</div>
                </div>
              </div>
              <div className="hierarchy-timeline-row-bars">
                <div
                  className="hierarchy-timeline-row-track"
                  aria-hidden="true"
                >
                  <span className="hierarchy-timeline-row-bar" />
                </div>
                <div className="hierarchy-timeline-row-duration">
                  {formatElapsedLabel(row.durationMs)}
                </div>
              </div>
            </Fragment>
          );

          if (isTraceRow) {
            return (
              <div
                key={row.id}
                role="listitem"
                title={buildHierarchyTimelineRowTooltip(row)}
                aria-current={
                  row.isActive || row.isDetailTrace ? "true" : undefined
                }
                data-hierarchy-row-id={row.id}
              >
                <button
                  type="button"
                  className={rowClassName}
                  style={rowStyle}
                  onClick={() => onSelectRow(row.id)}
                >
                  {rowContent}
                </button>
              </div>
            );
          }

          return (
            <div
              key={row.id}
              role="listitem"
              className={rowClassName}
              style={rowStyle}
              title={buildHierarchyTimelineRowTooltip(row)}
              aria-current={
                row.isActive || row.isDetailTrace ? "true" : undefined
              }
              data-hierarchy-row-id={row.id}
            >
              {rowContent}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TraceDetailPanel({
  activeTab,
  detail,
  detailTabs,
  fallbackTrace,
  jsonMode,
  onApplyTagFilter,
  onApplyTraceFilter,
  onBack,
  onNavigateHierarchyNode,
  onSelectTimelineNode,
  onTabChange,
  onToggleJsonMode,
  timelineModel,
}: {
  activeTab: TabId;
  detail: TraceRecord | null;
  detailTabs: Array<{ id: TabId; label: string }>;
  fallbackTrace: TraceSummary | null;
  jsonMode: JsonMode;
  onApplyTagFilter: (key: string, value: string) => void;
  onApplyTraceFilter: (intent: TraceFilterIntent) => void;
  onBack?: () => void;
  onNavigateHierarchyNode: (nodeId: string) => void;
  onSelectTimelineNode: (nodeId: string) => void;
  onTabChange: (value: string) => void;
  onToggleJsonMode: (tabId: TabId) => void;
  timelineModel: HierarchyTimelineModel | null;
}) {
  const traceDetailPrimaryRef = useRef<HTMLDivElement | null>(null);
  const [showInlineContextRail, setShowInlineContextRail] = useState(false);
  const detailCopy = detail
    ? getTraceDisplayCopy(detail)
    : fallbackTrace
      ? getTraceDisplayCopy(fallbackTrace)
      : null;
  const detailStatus = detail?.status ?? fallbackTrace?.status ?? null;
  const detailDuration = detail
    ? formatTraceDuration(detail)
    : fallbackTrace
      ? fallbackTrace.durationMs == null
        ? "Running"
        : `${fallbackTrace.durationMs} ms`
      : null;
  const detailSubtitle = formatTraceProviderSummary(detail ?? fallbackTrace);
  const detailCostUsd = detail
    ? getUsageCostUsd(detail.usage)
    : (fallbackTrace?.costUsd ?? null);
  const detailCostLabel = formatUsdCost(detailCostUsd);
  const hasSecondaryInspector = Boolean(detail && timelineModel);
  const detailFilterSource = detail ?? fallbackTrace;
  const canInlineContextRailTab =
    activeTab === "conversation" ||
    activeTab === "request" ||
    activeTab === "response";
  const visibleDetailTabs =
    canInlineContextRailTab && showInlineContextRail
      ? detailTabs.filter((tab) => tab.id !== "context")
      : detailTabs;
  const showContextRailInPrimary =
    showInlineContextRail &&
    canInlineContextRailTab &&
    jsonMode !== "raw" &&
    Boolean(detail);

  useEffect(() => {
    const element = traceDetailPrimaryRef.current;
    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }

      setShowInlineContextRail(entry.contentRect.width >= 1216);
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [detail]);

  return (
    <div className="trace-detail-panel" role="region" aria-label="Trace detail">
      <div className="trace-detail-header">
        <div className="trace-detail-heading">
          {detailCopy?.breadcrumbs?.length ? (
            <div className="trace-detail-breadcrumb" aria-label="Trace path">
              {detailCopy.breadcrumbs.map((item, index) => (
                <Fragment key={`${item.label}-${item.nodeId}`}>
                  {index > 0 ? (
                    <ChevronRight
                      className="trace-detail-breadcrumb-separator"
                      aria-hidden="true"
                    />
                  ) : null}
                  <button
                    type="button"
                    className={cn(
                      "trace-detail-breadcrumb-segment",
                      index === detailCopy.breadcrumbs.length - 1 &&
                        "is-current",
                    )}
                    onClick={() => onNavigateHierarchyNode(item.nodeId)}
                  >
                    {item.label}
                  </button>
                </Fragment>
              ))}
            </div>
          ) : null}
          <div className="trace-detail-title-row">
            <h2>{detailCopy?.title || "Loading trace"}</h2>
            <div className="trace-detail-meta">
              {detailStatus ? (
                <StatusBadge
                  status={detailStatus}
                  onClick={() => onApplyTraceFilter({ status: detailStatus })}
                />
              ) : null}
              {detailDuration ? (
                <TraceMetricPill tone="latency">
                  {detailDuration}
                </TraceMetricPill>
              ) : null}
              {detailCostLabel ? (
                <TraceMetricPill tone="cost">{detailCostLabel}</TraceMetricPill>
              ) : null}
            </div>
          </div>
          {detailSubtitle ? (
            <div className="trace-detail-subtitle">{detailSubtitle}</div>
          ) : detailCopy?.path ? (
            <div className="trace-detail-subtitle">{detailCopy.path}</div>
          ) : null}
          {detailFilterSource ? (
            <div className="trace-detail-filter-pills">
              <BadgeButton
                variant="secondary"
                semantic={startCase(detailFilterSource.kind)}
                onClick={() =>
                  onApplyTraceFilter({ kind: detailFilterSource.kind })
                }
              >
                {startCase(detailFilterSource.kind)}
              </BadgeButton>
              <BadgeButton
                variant="outline"
                onClick={() =>
                  onApplyTraceFilter({ tag: ["mode", detailFilterSource.mode] })
                }
              >
                {detailFilterSource.mode}
              </BadgeButton>
              {detailFilterSource.provider ? (
                <BadgeButton
                  variant="secondary"
                  onClick={() =>
                    onApplyTraceFilter({
                      tag: ["provider", detailFilterSource.provider as string],
                    })
                  }
                >
                  {detailFilterSource.provider}
                </BadgeButton>
              ) : null}
              {detailFilterSource.model ? (
                <BadgeButton
                  variant="secondary"
                  onClick={() =>
                    onApplyTraceFilter({
                      tag: ["model", detailFilterSource.model as string],
                    })
                  }
                >
                  {detailFilterSource.model}
                </BadgeButton>
              ) : null}
            </div>
          ) : null}
        </div>
        {onBack ? (
          <div className="trace-detail-actions">
            <Button variant="outline" onClick={onBack}>
              Show hierarchy
            </Button>
          </div>
        ) : null}
      </div>

      <Separator />

      <div className="trace-detail-body">
        {detail ? (
          <div
            className={cn(
              "trace-detail-main",
              hasSecondaryInspector && "has-secondary-inspector",
            )}
          >
            <div className="trace-detail-primary" ref={traceDetailPrimaryRef}>
              <div className="trace-detail-toolbar">
                <div className="trace-detail-tabs-shell">
                  <Tabs value={activeTab} onChange={onTabChange}>
                    <TabsList className="detail-tabs">
                      {visibleDetailTabs.map((tab) => (
                        <TabsTrigger key={tab.id} value={tab.id}>
                          {tab.label}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </Tabs>
                </div>
                <Button
                  variant="outline"
                  className="trace-detail-json-toggle"
                  onClick={() => onToggleJsonMode(activeTab)}
                >
                  <Boxes data-icon="inline-start" />
                  {jsonMode === "formatted" ? "Raw JSON" : "Formatted"}
                </Button>
              </div>
              <Separator />
              <div className="trace-detail-scroll">
                <div className="trace-detail-pane">
                  {showContextRailInPrimary ? (
                    <div className="detail-inline-context-layout">
                      <div className="detail-inline-context-main">
                        {renderTabContent(
                          activeTab,
                          detail,
                          jsonMode,
                          onApplyTagFilter,
                          onApplyTraceFilter,
                        )}
                      </div>
                      <aside
                        className="conversation-context-rail"
                        aria-label="Context summary"
                      >
                        <div className="conversation-context-rail-header">
                          <div className="conversation-context-rail-title">
                            Context
                          </div>
                          <div className="conversation-context-rail-copy">
                            Key trace metadata alongside the conversation.
                          </div>
                        </div>
                        <ContextInspectorView
                          detail={detail}
                          onApplyTagFilter={onApplyTagFilter}
                        />
                      </aside>
                    </div>
                  ) : (
                    renderTabContent(
                      activeTab,
                      detail,
                      jsonMode,
                      onApplyTagFilter,
                      onApplyTraceFilter,
                    )
                  )}
                </div>
              </div>
            </div>

            {timelineModel ? (
              <aside className="trace-detail-secondary">
                <HierarchyTimelineOverview
                  model={timelineModel}
                  onSelectRow={onSelectTimelineNode}
                />
              </aside>
            ) : null}
          </div>
        ) : (
          <div className="trace-detail-empty">
            <EmptyState
              icon={ArrowUpRight}
              title="Loading call"
              description="Fetching the full request, response, context, and stream details for this trace."
            />
          </div>
        )}
      </div>
    </div>
  );
}
function renderTabContent(
  tab: TabId,
  detail: TraceRecord,
  jsonMode: JsonMode,
  onApplyTagFilter: (key: string, value: string) => void,
  onApplyTraceFilter: (intent: TraceFilterIntent) => void,
) {
  const requestMessages = detail.request.input?.messages || [];
  const responseMessage = getResponseMessage(detail);
  const toolCalls = getToolCalls(detail);
  const usage = getUsage(detail);

  switch (tab) {
    case "conversation":
      if (jsonMode === "raw") {
        return (
          <div className="detail-grid">
            <JsonCard title="Request messages" value={requestMessages} />
            <JsonCard title="Response message" value={responseMessage} />
            {toolCalls.length ? (
              <JsonCard title="Tool calls" value={toolCalls} />
            ) : null}
            {detail.error ? (
              <JsonCard title="Error" value={detail.error} />
            ) : null}
          </div>
        );
      }

      return (
        <ConversationView
          detail={detail}
          onApplyTraceFilter={onApplyTraceFilter}
        />
      );
    case "request":
      if (jsonMode === "raw") {
        return <JsonCard title="Request payload" value={detail.request} />;
      }

      return (
        <div className="detail-grid">
          <MessagesCard
            insights={detail.insights}
            title="Request messages"
            messages={requestMessages}
            sourcePrefix="request"
          />
          <JsonCard title="Request options" value={detail.request.options} />
          {(detail.request.input?.tools || []).length ? (
            <JsonCard
              title="Available tools"
              value={detail.request.input?.tools}
            />
          ) : null}
        </div>
      );
    case "response":
      if (jsonMode === "raw") {
        return (
          <div className="detail-grid">
            <JsonCard
              title="Response payload"
              value={detail.response ?? detail.stream?.reconstructed ?? null}
            />
            {detail.error ? (
              <JsonCard title="Error" value={detail.error} />
            ) : null}
          </div>
        );
      }

      return (
        <div className="detail-grid">
          {responseMessage ? (
            <MessagesCard
              insights={detail.insights}
              title="Assistant message"
              messages={[responseMessage]}
              sourcePrefix="response"
            />
          ) : null}
          {toolCalls.length ? (
            <ToolCallsCard title="Tool calls" toolCalls={toolCalls} />
          ) : null}
          {usage ? <UsageInspectorCard usage={usage} /> : null}
          {detail.error ? (
            <JsonCard title="Error" value={detail.error} />
          ) : null}
          {!responseMessage && !toolCalls.length && !usage && !detail.error ? (
            <EmptyState
              icon={ArrowUpRight}
              title="No response payload"
              description="This call has not produced a final assistant message yet."
            />
          ) : null}
        </div>
      );
    case "context":
      if (jsonMode === "raw") {
        return (
          <JsonCard
            title="Context payload"
            value={{
              context: detail.context,
              hierarchy: detail.hierarchy,
              tags: detail.tags,
              timing: {
                endedAt: detail.endedAt,
                firstChunkMs: detail.stream?.firstChunkMs ?? null,
                startedAt: detail.startedAt,
                status: detail.status,
                streamChunks: detail.stream?.chunkCount ?? 0,
              },
            }}
          />
        );
      }

      return (
        <ContextInspectorView
          detail={detail}
          onApplyTagFilter={onApplyTagFilter}
        />
      );
    case "stream":
      if (!detail.stream) {
        return (
          <EmptyState
            icon={Activity}
            title="Non-stream trace"
            description="This model call finished in one response, so there is no chunk timeline."
          />
        );
      }

      if (jsonMode === "raw") {
        return <JsonCard title="Stream payload" value={detail.stream} />;
      }

      return (
        <div className="detail-grid">
          <StreamSummaryCard detail={detail} />
          <StreamTimelineCard detail={detail} />
          {detail.stream.reconstructed?.message ? (
            <MessagesCard
              insights={detail.insights}
              title="Reconstructed output"
              messages={[detail.stream.reconstructed.message as any]}
              sourcePrefix="stream"
            />
          ) : null}
          {detail.stream.reconstructed?.tool_calls?.length ? (
            <ToolCallsCard
              title="Reconstructed tool calls"
              toolCalls={detail.stream.reconstructed.tool_calls}
            />
          ) : null}
        </div>
      );
    default:
      return null;
  }
}

function ConversationView({
  detail,
  onApplyTraceFilter,
}: {
  detail: TraceRecord;
  onApplyTraceFilter: (intent: TraceFilterIntent) => void;
}) {
  const requestMessages = detail.request.input?.messages || [];
  const responseMessage = getResponseMessage(detail);
  const responseToolCalls = getToolCalls(detail).filter(
    (toolCall) => !messageListHasToolCall(requestMessages, toolCall),
  );
  const costUsd = getUsageCostUsd(detail.usage);
  const costLabel = formatUsdCost(costUsd);
  const traceInsights = detail.insights ?? EMPTY_TRACE_INSIGHTS;

  return (
    <div className="conversation-layout">
      <div className="conversation-meta">
        <div className="conversation-meta-primary">
          <StatusBadge
            status={detail.status}
            onClick={() => onApplyTraceFilter({ status: detail.status })}
          />
          {detail.endedAt ? (
            <TraceMetricPill tone="latency">
              {Math.max(
                0,
                Date.parse(detail.endedAt) - Date.parse(detail.startedAt),
              )}{" "}
              ms
            </TraceMetricPill>
          ) : (
            <TraceMetricPill tone="latency">Running</TraceMetricPill>
          )}
          {costLabel ? (
            <TraceMetricPill tone="cost">{costLabel}</TraceMetricPill>
          ) : null}
        </div>
        <div className="conversation-meta-secondary">
          <BadgeButton
            variant="secondary"
            semantic={startCase(detail.kind)}
            onClick={() => onApplyTraceFilter({ kind: detail.kind })}
          >
            {startCase(detail.kind)}
          </BadgeButton>
          <BadgeButton
            variant="outline"
            onClick={() => onApplyTraceFilter({ tag: ["mode", detail.mode] })}
          >
            {detail.mode}
          </BadgeButton>
          {detail.provider ? (
            <BadgeButton
              variant="secondary"
              onClick={() =>
                onApplyTraceFilter({
                  tag: ["provider", detail.provider as string],
                })
              }
            >
              {detail.provider}
            </BadgeButton>
          ) : null}
          {detail.model ? (
            <BadgeButton
              variant="secondary"
              onClick={() =>
                onApplyTraceFilter({ tag: ["model", detail.model as string] })
              }
            >
              {detail.model}
            </BadgeButton>
          ) : null}
        </div>
      </div>

      {traceInsights.highlights.length || traceInsights.structuredInputs.length ? (
        <TraceInsightsSummary detail={detail} insights={traceInsights} />
      ) : null}

      <div className="conversation-thread">
        {requestMessages.length ? (
          requestMessages.map((message, index) => (
            <ConversationMessage
              key={`${message.role}-${index}`}
              insights={traceInsights}
              message={message}
              source={`request:${index}`}
            />
          ))
        ) : (
          <div className="muted-copy">No request messages recorded.</div>
        )}

        {hasRenderableContent(responseMessage?.content) ? (
          <ConversationMessage
            insights={traceInsights}
            message={{
              role: responseMessage?.role || "assistant",
              content: responseMessage?.content,
            }}
            source="response:0"
          />
        ) : null}

        {responseToolCalls.map((toolCall, index) => (
          <ToolCallBubble
            key={toolCall.id || toolCall.name || `response-tool-${index}`}
            toolCall={toolCall}
            index={index}
          />
        ))}

        {detail.error ? <JsonCard title="Error" value={detail.error} /> : null}
      </div>
    </div>
  );
}

function TraceInsightsSummary({
  detail,
  insights,
}: {
  detail: TraceRecord;
  insights: TraceInsights;
}) {
  const title =
    detail.kind === "guardrail" ? "Why this guardrail ran" : "Trace insights";
  const highlights = insights.highlights.filter(
    (item) => item.kind !== "structured-input" || !insights.structuredInputs.length,
  );

  return (
    <Card className="detail-section trace-insights-card">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          Deterministic signals extracted from the trace payload.
        </CardDescription>
      </CardHeader>
      <CardContent className="trace-insights-content">
        {highlights.map((highlight, index) => (
          <div
            key={`${highlight.kind}-${highlight.source}-${index}`}
            className="trace-insight-item"
          >
            <div className="trace-insight-item-header">
              <Badge semantic="guardrail" variant="secondary">
                {highlight.title}
              </Badge>
              <span className="trace-insight-item-source">
                {formatInsightSource(highlight.source)}
              </span>
            </div>
            <div className="trace-insight-item-copy">
              {highlight.description}
            </div>
          </div>
        ))}
        {insights.structuredInputs.map((item, index) => (
          <div
            key={`${item.role}-${item.snippet}-${index}`}
            className="trace-insight-item is-structured"
          >
            <div className="trace-insight-item-header">
              <Badge semantic="guardrail" variant="secondary">
                Structured {item.role} input
              </Badge>
              <div className="trace-insight-item-tags">
                {item.tags.map((tag) => (
                  <Badge key={tag} variant="outline">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
            <div className="trace-insight-item-copy">{item.snippet}</div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ConversationMessage({
  insights = EMPTY_TRACE_INSIGHTS,
  message,
  source,
}: {
  insights?: TraceInsights;
  message: {
    content: any;
    role: string;
    name?: string;
    tool_call_id?: string;
    tool_calls?: any[];
  };
  source: string;
}) {
  const toolCalls = getMessageToolCalls(message);

  if (message.role === "tool") {
    return (
      <ToolResultBubble
        content={message.content}
        name={message.name}
        toolCallId={message.tool_call_id}
      />
    );
  }

  if (toolCalls.length) {
    const messageInsights = getMessageInsightMatches(
      insights,
      source,
      message.role,
      message.content,
    );
    return (
      <Fragment>
        {hasRenderableContent(message.content) ? (
          <ConversationBubble
            role={message.role}
            content={message.content}
            insights={messageInsights}
          />
        ) : null}
        {toolCalls.map((toolCall, index) => (
          <ToolCallBubble
            key={
              toolCall.id || toolCall.name || `${message.role}-tool-${index}`
            }
            toolCall={toolCall}
            index={index}
          />
        ))}
      </Fragment>
    );
  }

  if (!hasRenderableContent(message.content)) {
    return null;
  }

  const messageInsights = getMessageInsightMatches(
    insights,
    source,
    message.role,
    message.content,
  );

  return (
    <ConversationBubble
      content={message.content}
      insights={messageInsights}
      role={message.role}
    />
  );
}

function ConversationBubble({
  content,
  insights,
  role,
}: {
  content: any;
  insights: MessageInsightMatches;
  role: string;
}) {
  const tone =
    role === "user"
      ? "is-user"
      : role === "assistant"
        ? "is-assistant"
        : "is-system";

  return (
    <div className={clsx("conversation-row", tone)}>
      <div className="conversation-role">{role}</div>
      <div className="conversation-bubble">
        {insights.structuredInputs.length || insights.highlights.length ? (
          <MessageInsightBanner insights={insights} />
        ) : null}
        <RichMessageContent content={content} role={role} />
      </div>
    </div>
  );
}

function ToolResultBubble({
  content,
  name,
  toolCallId,
}: {
  content: any;
  name?: string;
  toolCallId?: string;
}) {
  return (
    <div className="conversation-row is-tool">
      <div className="conversation-role">tool</div>
      <div className="conversation-bubble tool-result-bubble">
        <div className="tool-result-meta">
          {name ? <Badge variant="outline">{name}</Badge> : null}
          {toolCallId ? <Badge variant="secondary">{toolCallId}</Badge> : null}
        </div>
        <div className="tool-result-content">
          <RichMessageContent content={content} role="tool" />
        </div>
      </div>
    </div>
  );
}

function ToolCallBubble({ index, toolCall }: { index: number; toolCall: any }) {
  return (
    <div className="conversation-row is-tool-call">
      <div className="conversation-role">tool call</div>
      <div className="conversation-bubble tool-call-bubble">
        <div className="tool-call-header">
          <Badge variant="outline">{getToolCallName(toolCall, index)}</Badge>
          {toolCall?.id ? (
            <Badge variant="secondary">{toolCall.id}</Badge>
          ) : null}
        </div>
        <div className="tool-call-body">
          <div className="tool-call-section">
            <div className="tool-call-label">Arguments</div>
            <PrettyJson value={getToolCallArguments(toolCall)} />
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageInsightBanner({
  insights,
}: {
  insights: MessageInsightMatches;
}) {
  return (
    <div className="message-insight-banner">
      {insights.structuredInputs.map((item, index) => (
        <div
          key={`${item.role}-${item.snippet}-${index}`}
          className="message-insight-card"
        >
          <div className="message-insight-card-header">
            <Badge semantic="guardrail" variant="secondary">
              Structured input
            </Badge>
            <div className="message-insight-card-tags">
              {item.tags.slice(0, 3).map((tag) => (
                <Badge key={tag} variant="outline">
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
          <div className="message-insight-card-copy">
            XML-like markup detected in this {item.role} message.
          </div>
        </div>
      ))}
      {insights.highlights.map((highlight, index) => (
        <div
          key={`${highlight.kind}-${highlight.source}-${index}`}
          className="message-insight-card is-highlight"
        >
          <div className="message-insight-card-header">
            <Badge semantic="guardrail" variant="secondary">
              {highlight.title}
            </Badge>
          </div>
          <div className="message-insight-card-copy">
            {highlight.description}
          </div>
        </div>
      ))}
    </div>
  );
}

function getMessageInsightMatches(
  insights: TraceInsights,
  source: string,
  role: string,
  content: any,
): MessageInsightMatches {
  const text = extractPlainMessageText(content);
  const normalizedText = text ? text.replace(/\s+/g, " ") : null;
  const structuredInputs = insights.structuredInputs.filter(
    (item) =>
      item.role === role &&
      normalizedText !== null &&
      normalizedText.includes(item.snippet.replace(/\.\.\.$/, "")),
  );

  return {
    highlights: insights.highlights.filter(
      (highlight) =>
        !(highlight.kind === "structured-input" && structuredInputs.length) &&
        (
          highlight.source === source ||
          (normalizedText !== null &&
            highlight.snippet.length > 0 &&
            normalizedText.includes(highlight.snippet.replace(/\.\.\.$/, "")))
        ),
    ),
    structuredInputs,
  };
}

function RichMessageContent({
  content,
  role,
}: {
  content: any;
  role?: string;
}) {
  const jsonValue = useMemo(() => detectJsonValue(content), [content]);
  const markdown = useMemo(
    () => (jsonValue === null ? toMarkdownText(content) : null),
    [content, jsonValue],
  );
  const structuredMarkup = useMemo(
    () =>
      jsonValue === null && markdown !== null
        ? detectStructuredMarkup(markdown)
        : null,
    [jsonValue, markdown],
  );
  const collapseText = useMemo(
    () => getMessageCollapseText(content, jsonValue, markdown),
    [content, jsonValue, markdown],
  );
  const canCollapse = useMemo(
    () => shouldCollapseMessage(collapseText, role),
    [collapseText, role],
  );
  const isStructured = useMemo(
    () => jsonValue !== null || markdown === null || structuredMarkup !== null,
    [jsonValue, markdown, structuredMarkup],
  );
  const collapsedHeight =
    role === "system"
      ? isStructured
        ? MESSAGE_COLLAPSE_HEIGHT_STRUCTURED_SYSTEM
        : MESSAGE_COLLAPSE_HEIGHT_PROSE_SYSTEM
      : isStructured
        ? MESSAGE_COLLAPSE_HEIGHT_STRUCTURED
        : MESSAGE_COLLAPSE_HEIGHT_PROSE;
  const summaryLabel = formatCollapsedSummary(collapseText);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [collapseText]);

  const renderedContent = useMemo<ReactNode>(() => {
    if (jsonValue !== null) {
      return <PrettyJson value={jsonValue} />;
    }

    if (structuredMarkup !== null && markdown !== null) {
      return (
        <StructuredMarkupBlock
          markup={structuredMarkup}
          text={markdown}
        />
      );
    }

    if (markdown !== null) {
      return (
        <Suspense fallback={<pre>{markdown}</pre>}>
          <MarkdownBlock markdown={markdown} />
        </Suspense>
      );
    }

    return <pre>{JSON.stringify(content, null, 2)}</pre>;
  }, [content, jsonValue, markdown, structuredMarkup]);

  if (!canCollapse) {
    return renderedContent;
  }

  return (
    <ExpandableContent
      collapsedHeight={collapsedHeight}
      expanded={expanded}
      summaryLabel={summaryLabel}
      onToggle={() => setExpanded((current) => !current)}
    >
      {renderedContent}
    </ExpandableContent>
  );
}

function StructuredMarkupBlock({
  markup,
  text,
}: {
  markup: { tags: string[]; tokens: Array<{ type: string; value: string }> };
  text: string;
}) {
  return (
    <div className="structured-markup-block">
      <div className="structured-markup-header">
        <Badge semantic="guardrail" variant="secondary">
          Structured input
        </Badge>
        <div className="structured-markup-tags">
          {markup.tags.map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
        </div>
      </div>
      <pre className="structured-markup-pre" aria-label="Structured message">
        {markup.tokens.length
          ? markup.tokens.map((token, index) => (
              <span
                key={`${token.type}-${index}`}
                className={`structured-markup-token is-${token.type}`}
              >
                {token.value}
              </span>
            ))
          : text}
      </pre>
    </div>
  );
}

function PrettyJson({ value }: { value: any }) {
  const json = useMemo(
    () => (value === undefined ? "undefined" : JSON.stringify(value, null, 2)),
    [value],
  );
  const tokens = useMemo(() => tokenizeJson(json), [json]);

  return (
    <div className="json-frame">
      <pre className="json-syntax">{tokens}</pre>
    </div>
  );
}

function ExpandableContent({
  collapsedHeight,
  children,
  expanded,
  onToggle,
  summaryLabel,
}: {
  collapsedHeight: string;
  children: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  summaryLabel: string | null;
}) {
  return (
    <div className={cn("expandable-content", expanded && "is-expanded")}>
      <div
        className={cn("expandable-content-frame", !expanded && "is-collapsed")}
        style={{ "--collapsed-height": collapsedHeight } as CSSProperties}
      >
        {children}
        {!expanded ? (
          <div className="expandable-content-fade" aria-hidden="true" />
        ) : null}
      </div>
      <button type="button" className="expandable-toggle" onClick={onToggle}>
        {expanded
          ? "Show less"
          : summaryLabel
            ? `Show more · ${summaryLabel}`
            : "Show more"}
      </button>
    </div>
  );
}

function KeyValueCard({
  entries,
  title,
}: {
  entries: Record<string, any>;
  title: string;
}) {
  const filteredEntries = Object.entries(entries).filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );
  return (
    <Card className="detail-section">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="kv-grid">
          {filteredEntries.map(([key, value]) => (
            <Fragment key={key}>
              <dt>{key}</dt>
              <dd>{String(value)}</dd>
            </Fragment>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

type MetadataEntry = {
  copyValue?: string;
  filterKey?: string;
  filterValue?: string;
  label: string;
  monospace?: boolean;
  secondary?: string;
  value: string;
};

function ContextInspectorView({
  detail,
  onApplyTagFilter,
}: {
  detail: TraceRecord;
  onApplyTagFilter: (key: string, value: string) => void;
}) {
  const durationMs = detail.endedAt
    ? Math.max(0, Date.parse(detail.endedAt) - Date.parse(detail.startedAt))
    : null;
  const startedAt = formatTimestampDetails(detail.startedAt);
  const endedAt = detail.endedAt
    ? formatTimestampDetails(detail.endedAt)
    : null;
  const standardTagKeys = new Set([
    "actorId",
    "actorType",
    "agentId",
    "guardrailPhase",
    "guardrailType",
    "chatId",
    "contextType",
    "kind",
    "mode",
    "model",
    "parentSessionId",
    "parentChatId",
    "provider",
    "rootActorId",
    "rootSessionId",
    "rootChatId",
    "sessionId",
    "stage",
    "systemType",
    "tenantId",
    "topLevelAgentId",
    "userId",
    "watchdogPhase",
    "workflowState",
  ]);

  const hierarchyEntries: MetadataEntry[] = [
    createMetadataEntry("sessionId", detail.context.sessionId),
    createMetadataEntry("rootSessionId", detail.context.rootSessionId),
    createMetadataEntry("parentSessionId", detail.context.parentSessionId),
    createMetadataEntry("rootActorId", detail.context.rootActorId),
    createMetadataEntry("actorId", detail.context.actorId),
    createMetadataEntry("actorType", detail.context.actorType, {
      monospace: false,
    }),
  ].filter(Boolean) as MetadataEntry[];

  const traceEntries: MetadataEntry[] = [
    createMetadataEntry("kind", detail.kind, { monospace: false }),
    createMetadataEntry("mode", detail.mode, { monospace: false }),
    createMetadataEntry("provider", detail.provider, { monospace: false }),
    createMetadataEntry("model", detail.model, { monospace: false }),
    createMetadataEntry("userId", detail.context.userId),
    createMetadataEntry("tenantId", detail.context.tenantId),
    createMetadataEntry("guardrailType", detail.context.guardrailType, {
      monospace: false,
    }),
    createMetadataEntry("guardrailPhase", detail.context.guardrailPhase, {
      monospace: false,
    }),
    createMetadataEntry("stage", detail.context.stage, { monospace: false }),
  ].filter(Boolean) as MetadataEntry[];

  const timingEntries: MetadataEntry[] = [
    durationMs !== null
      ? {
          copyValue: String(durationMs),
          label: "duration",
          value: formatDurationText(durationMs),
        }
      : null,
    {
      copyValue: detail.startedAt,
      label: "startedAt",
      secondary: startedAt.secondary,
      value: startedAt.primary,
    },
    {
      copyValue: detail.endedAt || "in progress",
      label: "endedAt",
      secondary: endedAt?.secondary,
      value: endedAt?.primary || "In progress",
    },
    detail.stream?.firstChunkMs !== null &&
    detail.stream?.firstChunkMs !== undefined
      ? {
          copyValue: String(detail.stream.firstChunkMs),
          label: "firstChunkMs",
          value: formatDurationText(detail.stream.firstChunkMs),
        }
      : null,
    detail.stream?.chunkCount
      ? {
          copyValue: String(detail.stream.chunkCount),
          label: "streamChunks",
          value: String(detail.stream.chunkCount),
        }
      : null,
    {
      copyValue: detail.status,
      label: "status",
      value: startCase(detail.status),
    },
  ].filter(Boolean) as MetadataEntry[];

  const extraTags = Object.entries(detail.tags)
    .filter(([key, value]) => value && !standardTagKeys.has(key))
    .sort(([left], [right]) => left.localeCompare(right));

  return (
    <div className="detail-grid">
      <MetadataCard
        title="Hierarchy"
        entries={hierarchyEntries}
        onApplyTagFilter={onApplyTagFilter}
      />
      <MetadataCard
        title="Trace"
        entries={traceEntries}
        onApplyTagFilter={onApplyTagFilter}
      />
      <MetadataCard
        title="Timing"
        entries={timingEntries}
        onApplyTagFilter={onApplyTagFilter}
        footer={
          <TimingOverview
            durationMs={durationMs}
            firstChunkMs={detail.stream?.firstChunkMs ?? null}
          />
        }
      />
      <TagChipsCard tags={extraTags} onApplyTagFilter={onApplyTagFilter} />
    </div>
  );
}

function MetadataCard({
  entries,
  footer,
  onApplyTagFilter,
  title,
}: {
  entries: MetadataEntry[];
  footer?: ReactNode;
  onApplyTagFilter: (key: string, value: string) => void;
  title: string;
}) {
  return (
    <Card className="detail-section metadata-card">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="metadata-card-content">
        <dl className="metadata-grid">
          {entries.map((entry) => {
            const hasActions = Boolean(
              entry.copyValue || (entry.filterKey && entry.filterValue),
            );

            return (
              <Fragment key={`${title}-${entry.label}`}>
                <dt>{entry.label}</dt>
                <dd>
                  <div className="metadata-value-shell">
                    <div className="metadata-value-copy">
                      <div
                        className={cn(
                          "metadata-value",
                          entry.monospace !== false && "is-monospace",
                        )}
                        title={entry.copyValue || entry.value}
                      >
                        {formatInspectorValue(entry.value)}
                      </div>
                      {entry.secondary ? (
                        <div className="metadata-secondary">
                          {entry.secondary}
                        </div>
                      ) : null}
                    </div>
                    {hasActions ? (
                      <div className="metadata-actions">
                        {entry.copyValue ? (
                          <CopyActionButton value={entry.copyValue} />
                        ) : null}
                        {entry.filterKey && entry.filterValue ? (
                          <MetadataActionButton
                            label={`Filter by ${entry.label}`}
                            onClick={() =>
                              onApplyTagFilter(
                                entry.filterKey as string,
                                entry.filterValue as string,
                              )
                            }
                          >
                            <Filter data-icon="inline-start" />
                          </MetadataActionButton>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </dd>
              </Fragment>
            );
          })}
        </dl>
        {footer}
      </CardContent>
    </Card>
  );
}

function TimingOverview({
  durationMs,
  firstChunkMs,
}: {
  durationMs: number | null;
  firstChunkMs: number | null;
}) {
  if (durationMs === null) {
    return null;
  }

  const firstChunkPercent =
    firstChunkMs !== null && firstChunkMs > 0 && durationMs > 0
      ? Math.max(0, Math.min(100, (firstChunkMs / durationMs) * 100))
      : null;

  return (
    <div className="timing-overview">
      <div className="timing-bar" aria-hidden="true">
        <div className="timing-bar-fill" />
        {firstChunkPercent !== null ? (
          <div
            className="timing-marker"
            style={{ left: `${firstChunkPercent}%` }}
          />
        ) : null}
      </div>
      <div className="timing-legend">
        <span>Total {formatDurationText(durationMs)}</span>
        {firstChunkMs !== null ? (
          <span>First chunk {formatDurationText(firstChunkMs)}</span>
        ) : null}
      </div>
    </div>
  );
}

function TagChipsCard({
  tags,
  onApplyTagFilter,
}: {
  tags: Array<[string, string]>;
  onApplyTagFilter: (key: string, value: string) => void;
}) {
  return (
    <Card className="detail-section metadata-card">
      <CardHeader>
        <CardTitle>Tags</CardTitle>
      </CardHeader>
      <CardContent className="metadata-card-content">
        {tags.length ? (
          <div className="tag-chip-list">
            {tags.map(([key, value]) => (
              <div key={`${key}:${value}`} className="tag-chip">
                <div className="tag-chip-copy" title={`${key}:${value}`}>
                  <span className="tag-chip-key">{key}</span>
                  <span className="tag-chip-value">
                    {formatInspectorValue(value)}
                  </span>
                </div>
                <div className="tag-chip-actions">
                  <CopyActionButton value={`${key}:${value}`} />
                  <MetadataActionButton
                    label={`Filter by ${key}`}
                    onClick={() => onApplyTagFilter(key, value)}
                  >
                    <Filter data-icon="inline-start" />
                  </MetadataActionButton>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted-copy">
            No additional tags beyond the structured fields above.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CopyActionButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const onClick = async () => {
    const success = await copyText(value);
    if (!success) {
      return;
    }

    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <MetadataActionButton
      label={copied ? "Copied" : "Copy value"}
      onClick={() => void onClick()}
    >
      {copied ? (
        <Check data-icon="inline-start" />
      ) : (
        <Copy data-icon="inline-start" />
      )}
    </MetadataActionButton>
  );
}

function MetadataActionButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="metadata-action-button"
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function MessagesCard({
  insights = EMPTY_TRACE_INSIGHTS,
  messages,
  sourcePrefix,
  title,
}: {
  insights?: TraceInsights;
  messages: Array<{ content: any; role: string }>;
  sourcePrefix: "request" | "response" | "stream";
  title: string;
}) {
  return (
    <Card className="detail-section">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="message-stack">
        {messages.length ? (
          messages.map((message, index) => (
            <StructuredMessageCard
              key={`${message.role}-${index}`}
              insights={insights}
              message={message}
              source={`${sourcePrefix}:${index}`}
            />
          ))
        ) : (
          <div className="muted-copy">No messages recorded.</div>
        )}
      </CardContent>
    </Card>
  );
}

function ToolCallsCard({
  title,
  toolCalls,
}: {
  title: string;
  toolCalls: any[];
}) {
  return (
    <Card className="detail-section">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="message-stack">
        <ToolCallStack toolCalls={toolCalls} />
      </CardContent>
    </Card>
  );
}

function StructuredMessageCard({
  insights = EMPTY_TRACE_INSIGHTS,
  message,
  source,
}: {
  insights?: TraceInsights;
  message: {
    content: any;
    name?: string;
    role: string;
    tool_call_id?: string;
    tool_calls?: any[];
  };
  source: string;
}) {
  const toolCalls = getMessageToolCalls(message);
  const hasContent = hasRenderableContent(message.content);
  const isToolCallTurn = toolCalls.length > 0;
  const isToolResult = message.role === "tool";
  const messageInsights = getMessageInsightMatches(
    insights,
    source,
    message.role,
    message.content,
  );

  return (
    <div className={cn("message-card", `role-${message.role}`)}>
      <div className="message-card-header">
        <Badge semantic={message.role} variant="secondary">
          {message.role}
        </Badge>
        <div className="message-card-header-meta">
          {isToolResult && message.name ? (
            <Badge variant="outline">{message.name}</Badge>
          ) : null}
          {isToolResult && message.tool_call_id ? (
            <Badge variant="secondary">{message.tool_call_id}</Badge>
          ) : null}
          {isToolCallTurn ? (
            <Badge semantic="tool-call" variant="outline">
              {formatCountLabel(toolCalls.length, "tool call")}
            </Badge>
          ) : null}
        </div>
      </div>
      <div className="message-card-body">
        {messageInsights.structuredInputs.length || messageInsights.highlights.length ? (
          <MessageInsightBanner insights={messageInsights} />
        ) : null}
        {hasContent ? (
          <RichMessageContent content={message.content} role={message.role} />
        ) : isToolCallTurn ? (
          <div className="message-card-hint">Tool call emitted.</div>
        ) : (
          <div className="message-card-hint">No content recorded.</div>
        )}
        {isToolCallTurn ? (
          <ToolCallStack toolCalls={toolCalls} compact />
        ) : null}
      </div>
    </div>
  );
}

function ToolCallStack({
  compact = false,
  toolCalls,
}: {
  compact?: boolean;
  toolCalls: any[];
}) {
  return (
    <div className={cn("tool-call-stack", compact && "is-compact")}>
      {toolCalls.map((toolCall, index) => (
        <div
          key={toolCall?.id || `${getToolCallName(toolCall, index)}-${index}`}
          className="tool-call-stack-item"
        >
          <div className="tool-call-header">
            <Badge variant="outline">{getToolCallName(toolCall, index)}</Badge>
            {toolCall?.id ? (
              <Badge variant="secondary">{toolCall.id}</Badge>
            ) : null}
          </div>
          <div className="message-card-body">
            <PrettyJson value={getToolCallArguments(toolCall)} />
          </div>
        </div>
      ))}
    </div>
  );
}

function JsonCard({ title, value }: { title: string; value: any }) {
  return (
    <Card className="detail-section">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <PrettyJson value={value} />
      </CardContent>
    </Card>
  );
}

function UsageInspectorCard({ usage }: { usage: Record<string, any> }) {
  const promptTokens = toFiniteNumber(usage?.tokens?.prompt);
  const completionTokens = toFiniteNumber(usage?.tokens?.completion);
  const totalTokens =
    toFiniteNumber(usage?.tokens?.total) ??
    ((promptTokens ?? 0) + (completionTokens ?? 0) || null);
  const promptCost = getUsageSegmentCostUsd(usage, "prompt");
  const completionCost = getUsageSegmentCostUsd(usage, "completion");
  const totalCost = getUsageCostUsd(usage);
  const usageEntries: MetadataEntry[] = [
    createNumberMetadataEntry("promptTokens", promptTokens),
    createNumberMetadataEntry("completionTokens", completionTokens),
    createNumberMetadataEntry("totalTokens", totalTokens),
    createCurrencyMetadataEntry(
      "promptCost",
      promptCost,
      formatPricingRate(usage?.pricing?.prompt),
    ),
    createCurrencyMetadataEntry(
      "completionCost",
      completionCost,
      formatPricingRate(usage?.pricing?.completion),
    ),
    createCurrencyMetadataEntry("totalCost", totalCost),
  ].filter(Boolean) as MetadataEntry[];

  return (
    <MetadataCard
      title="Usage"
      entries={usageEntries}
      onApplyTagFilter={() => {}}
    />
  );
}

function StreamSummaryCard({ detail }: { detail: TraceRecord }) {
  const durationMs = detail.endedAt
    ? Math.max(0, Date.parse(detail.endedAt) - Date.parse(detail.startedAt))
    : null;
  const entries: MetadataEntry[] = [
    {
      copyValue: detail.status,
      label: "status",
      value: startCase(detail.status),
    },
    detail.stream?.chunkCount !== undefined
      ? {
          copyValue: String(detail.stream.chunkCount),
          label: "chunkCount",
          value: String(detail.stream.chunkCount),
        }
      : null,
    detail.stream?.firstChunkMs !== null &&
    detail.stream?.firstChunkMs !== undefined
      ? {
          copyValue: String(detail.stream.firstChunkMs),
          label: "firstChunk",
          value: formatDurationText(detail.stream.firstChunkMs),
        }
      : null,
    durationMs !== null
      ? {
          copyValue: String(durationMs),
          label: "duration",
          value: formatDurationText(durationMs),
        }
      : null,
  ].filter(Boolean) as MetadataEntry[];

  return (
    <MetadataCard
      title="Stream summary"
      entries={entries}
      onApplyTagFilter={() => {}}
      footer={
        <TimingOverview
          durationMs={durationMs}
          firstChunkMs={detail.stream?.firstChunkMs ?? null}
        />
      }
    />
  );
}

function StreamTimelineCard({ detail }: { detail: TraceRecord }) {
  const model = useMemo(() => buildStreamTimelineModel(detail), [detail]);

  return (
    <Card className="detail-section">
      <CardHeader>
        <CardTitle>Chunk timeline</CardTitle>
      </CardHeader>
      <CardContent className="stream-card-content">
        {model.buckets.length ? (
          <div className="stream-density-chart" aria-hidden="true">
            {model.buckets.map((value, index) => (
              <span
                key={`${index}-${value}`}
                className="stream-density-bar"
                style={
                  {
                    "--height": `${Math.max(10, (value / model.maxBucket) * 100)}%`,
                  } as CSSProperties
                }
              />
            ))}
          </div>
        ) : null}

        <div className="stream-density-legend">
          <span>{formatCountLabel(model.chunkCount, "chunk")}</span>
          {model.totalDurationMs !== null ? (
            <span>Total {formatDurationText(model.totalDurationMs)}</span>
          ) : null}
          {model.firstChunkMs !== null ? (
            <span>First chunk {formatDurationText(model.firstChunkMs)}</span>
          ) : null}
        </div>

        {model.segments.length ? (
          <div className="stream-segment-list">
            {model.segments.map((segment, index) => (
              <div
                key={`${segment.offsetMs}-${index}`}
                className="stream-segment"
              >
                <div className="stream-segment-time">
                  +{formatDurationText(segment.offsetMs)}
                </div>
                <div className="stream-segment-copy">{segment.text}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted-copy">
            No incremental text chunks were recorded for this stream.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyState({
  description,
  icon: Icon,
  title,
}: {
  description: string;
  icon: typeof Activity;
  title: string;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">
        <Icon />
      </div>
      <div className="empty-state-title">{title}</div>
      <div className="empty-state-description">{description}</div>
    </div>
  );
}

function buildDetailTabs(
  detail: TraceRecord | null,
): Array<{ id: TabId; label: string }> {
  if (!detail) {
    return [];
  }

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: "conversation", label: "Conversation" },
    { id: "request", label: "Request" },
    { id: "response", label: "Response" },
    { id: "context", label: "Context" },
  ];

  if (detail.stream) {
    tabs.push({ id: "stream", label: "Stream" });
  }
  return tabs;
}

function findNodeById(
  nodes: HierarchyNode[],
  id: string,
): HierarchyNode | null {
  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }

    const child = findNodeById(node.children, id);
    if (child) {
      return child;
    }
  }

  return null;
}

function findNodePath(
  nodes: HierarchyNode[],
  id: string,
  trail: HierarchyNode[] = [],
): HierarchyNode[] {
  for (const node of nodes) {
    const nextTrail = [...trail, node];
    if (node.id === id) {
      return nextTrail;
    }

    const childTrail = findNodePath(node.children, id, nextTrail);
    if (childTrail.length) {
      return childTrail;
    }
  }

  return [];
}

function getNewestTraceId(node: HierarchyNode | null): string | null {
  if (!node?.traceIds.length) {
    return null;
  }

  return node.traceIds[0] || null;
}

function getDefaultExpandedNodeIds(nodes: HierarchyNode[]): Set<string> {
  const expanded = new Set<string>();

  const visit = (node: HierarchyNode) => {
    if (
      node.children.length &&
      (node.type === "session" || node.type === "actor")
    ) {
      expanded.add(node.id);
    }

    for (const child of node.children) {
      visit(child);
    }
  };

  for (const node of nodes) {
    visit(node);
  }

  return expanded;
}

function getHierarchyNodeCopy(
  node: HierarchyNode,
  traceById: Map<string, TraceSummary>,
): { badge: string; label: string; meta: string } {
  switch (node.type) {
    case "session":
      return {
        badge: "Session",
        label: `Session ${shortId(node.meta.sessionId || node.label.replace(/^Session\s+/, ""))}`,
        meta: formatList([
          formatCountLabel(node.count, "call"),
          formatCostSummaryLabel(getHierarchyNodeCostUsd(node), node.count > 1),
        ]),
      };
    case "actor":
      return {
        badge: "Actor",
        label: node.meta.actorId || node.meta.rootActorId || node.label,
        meta: formatList([
          formatCountLabel(node.count, "call"),
          formatCostSummaryLabel(getHierarchyNodeCostUsd(node), node.count > 1),
        ]),
      };
    case "guardrail":
      return {
        badge: "Guardrail",
        label: `${capitalize(node.meta.guardrailPhase || "guardrail")} guardrail`,
        meta: formatList([
          formatCountLabel(node.count, "call"),
          formatCostSummaryLabel(getHierarchyNodeCostUsd(node), node.count > 1),
        ]),
      };
    case "child-actor":
      return {
        badge: "Child actor",
        label: `Child actor: ${node.meta.actorId || node.meta.childActorId || node.label}`,
        meta: formatList([
          formatCountLabel(node.count, "call"),
          formatCostSummaryLabel(getHierarchyNodeCostUsd(node), node.count > 1),
        ]),
      };
    case "stage":
      return {
        badge: "Stage",
        label: `Stage: ${node.meta.stage || node.meta.workflowState || node.label}`,
        meta: formatList([
          formatCountLabel(node.count, "call"),
          formatCostSummaryLabel(getHierarchyNodeCostUsd(node), node.count > 1),
        ]),
      };
    case "trace": {
      const trace = node.meta.traceId ? traceById.get(node.meta.traceId) : null;
      return {
        badge: "Call",
        label: trace ? getTraceTitle(trace) : node.label,
        meta: trace
          ? formatList([
              trace.provider,
              trace.model,
              formatCostSummaryLabel(
                trace.costUsd ?? getHierarchyNodeCostUsd(node),
                false,
              ),
            ])
          : formatList([
              formatCountLabel(node.count, "call"),
              formatCostSummaryLabel(
                getHierarchyNodeCostUsd(node),
                node.count > 1,
              ),
            ]),
      };
    }
    default:
      return {
        badge: startCase(node.type),
        label: node.label,
        meta: formatList([
          formatCountLabel(node.count, "call"),
          formatCostSummaryLabel(getHierarchyNodeCostUsd(node), node.count > 1),
        ]),
      };
  }
}

function getTraceDisplayCopy(
  trace: Pick<
    TraceSummary,
    "hierarchy" | "kind" | "mode" | "model" | "provider"
  >,
): {
  breadcrumbs: Array<{ label: string; nodeId: string }>;
  path: string;
  subtitle: string;
  title: string;
} {
  const actor = trace.hierarchy.childActorId || trace.hierarchy.rootActorId;
  const breadcrumbs = getTraceBreadcrumbs(trace);
  const pathParts = breadcrumbs.map((item) => item.label);

  return {
    breadcrumbs,
    path: pathParts.join(" / "),
    subtitle: formatList([actor, trace.provider, trace.model]),
    title: getTraceTitle(trace),
  };
}

function getTraceBreadcrumbs(
  trace: Pick<TraceSummary, "hierarchy" | "kind">,
): Array<{ label: string; nodeId: string }> {
  const sessionId = trace.hierarchy.sessionId || "unknown-session";
  const rootActorId = trace.hierarchy.rootActorId || "unknown-actor";
  const breadcrumbs = [
    {
      label: `Session ${shortId(sessionId)}`,
      nodeId: `session:${sessionId}`,
    },
    {
      label: rootActorId,
      nodeId: `actor:${sessionId}:${rootActorId}`,
    },
  ];

  if (trace.kind === "guardrail") {
    const label = `${capitalize(trace.hierarchy.guardrailPhase || "guardrail")} guardrail`;
    breadcrumbs.push({
      label,
      nodeId: `guardrail:${sessionId}:${rootActorId}:${trace.hierarchy.guardrailType || label.toLowerCase()}`,
    });
  } else if (trace.kind === "child-actor" && trace.hierarchy.childActorId) {
    breadcrumbs.push({
      label: `Child actor: ${trace.hierarchy.childActorId}`,
      nodeId: `child-actor:${sessionId}:${rootActorId}:${trace.hierarchy.childActorId}`,
    });
  } else if (trace.kind === "stage") {
    if (trace.hierarchy.childActorId) {
      breadcrumbs.push({
        label: `Child actor: ${trace.hierarchy.childActorId}`,
        nodeId: `child-actor:${sessionId}:${rootActorId}:${trace.hierarchy.childActorId}`,
      });
    }
    if (trace.hierarchy.stage) {
      breadcrumbs.push({
        label: `Stage: ${trace.hierarchy.stage}`,
        nodeId: `stage:${sessionId}:${rootActorId}:${trace.hierarchy.childActorId || "root"}:${trace.hierarchy.stage}`,
      });
    }
  }

  return breadcrumbs;
}

function formatTraceProviderSummary(
  trace:
    | Pick<TraceSummary, "model" | "provider">
    | Pick<TraceRecord, "model" | "provider">
    | null
    | undefined,
): string | null {
  if (!trace) {
    return null;
  }

  return formatList([trace.provider, trace.model]);
}

function groupTracesForNav(items: TraceSummary[]): Array<{
  costUsd: number | null;
  id: string;
  isAggregateCost: boolean;
  items: TraceSummary[];
  label: string;
  meta: string;
}> {
  const groups = new Map<string, TraceSummary[]>();
  const uniqueSessions = new Set(items.map((item) => item.hierarchy.sessionId));
  const groupMode = uniqueSessions.size > 1 ? "session" : "kind";

  for (const item of items) {
    const key =
      groupMode === "session"
        ? `session:${item.hierarchy.sessionId || "unknown-session"}`
        : `kind:${item.kind}:${item.hierarchy.guardrailPhase || item.hierarchy.stage || item.mode}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  return [...groups.entries()].map(([groupKey, traces]) => {
    const latestStartedAt = traces[0]?.startedAt ?? null;

    return {
      costUsd: sumTraceCosts(traces),
      id: `trace-group:${groupKey}`,
      isAggregateCost: traces.length > 1,
      items: traces,
      label:
        groupMode === "session"
          ? `Session ${shortId(traces[0]?.hierarchy.sessionId || "unknown")}`
          : getTraceActorLabel(traces[0] as TraceSummary),
      meta:
        formatList([
          latestStartedAt ? formatCompactTimestamp(latestStartedAt) : null,
          formatCountLabel(traces.length, "trace"),
        ]) || "No metadata",
    };
  });
}

function sumTraceCosts(items: TraceSummary[]): number | null {
  const costs = items
    .map((item) => item.costUsd)
    .filter(
      (value): value is number => value !== null && Number.isFinite(value),
    );
  if (!costs.length) {
    return null;
  }

  return roundCostUsd(costs.reduce((sum, value) => sum + value, 0));
}

function getTraceActorLabel(
  trace: Pick<TraceSummary, "hierarchy" | "kind">,
): string {
  if (trace.kind === "guardrail") {
    return `${capitalize(trace.hierarchy.guardrailPhase || "guardrail")} guardrail`;
  }

  if (trace.kind === "child-actor" && trace.hierarchy.childActorId) {
    return `Child actor: ${trace.hierarchy.childActorId}`;
  }

  if (trace.kind === "stage" && trace.hierarchy.stage) {
    return `Stage: ${trace.hierarchy.stage}`;
  }

  return trace.hierarchy.childActorId || trace.hierarchy.rootActorId;
}

function getTraceTitle(
  trace: Pick<TraceSummary, "hierarchy" | "kind" | "mode">,
): string {
  if (trace.kind === "guardrail") {
    return `${capitalize(trace.hierarchy.guardrailPhase || "guardrail")} guardrail check`;
  }

  if (trace.kind === "stage") {
    return trace.hierarchy.stage
      ? `Stage run: ${trace.hierarchy.stage}`
      : "Stage run";
  }

  if (trace.kind === "child-actor") {
    return `Child actor ${trace.mode}`;
  }

  if (trace.kind === "actor") {
    return trace.mode === "stream"
      ? "Actor response stream"
      : "Actor response invoke";
  }

  return `${startCase(trace.kind)} ${trace.mode}`;
}

function toTraceSummary(trace: TraceRecord): TraceSummary {
  return {
    costUsd: getUsageCostUsd(trace.usage),
    durationMs: trace.endedAt
      ? Math.max(0, Date.parse(trace.endedAt) - Date.parse(trace.startedAt))
      : null,
    endedAt: trace.endedAt,
    flags: {
      hasHighlights: Boolean(trace.insights?.highlights?.length),
      hasStructuredInput: Boolean(trace.insights?.structuredInputs?.length),
    },
    hierarchy: structuredClone(trace.hierarchy),
    id: trace.id,
    kind: trace.kind,
    mode: trace.mode,
    model: trace.model,
    provider: trace.provider,
    requestPreview: extractTraceRequestPreview(trace.request),
    responsePreview: extractTraceResponsePreview(trace),
    startedAt: trace.startedAt,
    status: trace.status,
    stream: trace.stream
      ? {
          chunkCount: trace.stream.chunkCount,
          firstChunkMs: trace.stream.firstChunkMs,
        }
      : null,
    tags: structuredClone(trace.tags),
  };
}

function normalizeTraceListPayload(
  payload: TraceListPayload,
): TraceListPayload {
  return {
    ...payload,
    items: payload.items.map(normalizeTraceSummary),
  };
}

function normalizeTraceSummary(summary: TraceSummary): TraceSummary {
  return {
    ...summary,
    costUsd:
      typeof summary.costUsd === "number" && Number.isFinite(summary.costUsd)
        ? summary.costUsd
        : null,
    durationMs:
      typeof summary.durationMs === "number" &&
      Number.isFinite(summary.durationMs)
        ? summary.durationMs
        : null,
    flags: {
      hasHighlights: Boolean(summary.flags?.hasHighlights),
      hasStructuredInput: Boolean(summary.flags?.hasStructuredInput),
    },
    stream: summary.stream
      ? {
          chunkCount:
            typeof summary.stream.chunkCount === "number" &&
            Number.isFinite(summary.stream.chunkCount)
              ? summary.stream.chunkCount
              : 0,
          firstChunkMs:
            typeof summary.stream.firstChunkMs === "number" &&
            Number.isFinite(summary.stream.firstChunkMs)
              ? summary.stream.firstChunkMs
              : null,
        }
      : null,
  };
}

function extractTraceRequestPreview(request: TraceRecord["request"]): string {
  const messages = request?.input?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return "";
  }

  const lastUserMessage = [...messages]
    .reverse()
    .find((message: any) => message?.role === "user");
  if (!lastUserMessage) {
    return summariseMessageValue(messages[messages.length - 1]?.content);
  }

  return summariseMessageValue(lastUserMessage.content);
}

function extractTraceResponsePreview(trace: TraceRecord): string {
  if (trace.mode === "stream") {
    const content = trace.stream?.reconstructed?.message?.content;
    if (content) {
      return summariseMessageValue(content);
    }
  }

  const content = trace.response?.message?.content;
  if (content) {
    return summariseMessageValue(content);
  }

  if (trace.error?.message) {
    return String(trace.error.message);
  }

  return "";
}

function summariseMessageValue(value: unknown, maxLength = 160): string {
  if (value === null || value === undefined) {
    return "";
  }

  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) {
    return "";
  }

  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}...`;
}

function replaceTraceSummary(
  items: TraceSummary[],
  nextSummary: TraceSummary,
): TraceSummary[] {
  const index = items.findIndex((item) => item.id === nextSummary.id);
  if (index === -1) {
    return items;
  }

  const nextItems = items.slice();
  nextItems[index] = nextSummary;
  return nextItems;
}

function patchHierarchyForTraceUpdate(
  nodes: HierarchyNode[],
  traceId: string,
  previousSummary: TraceSummary | null,
  nextSummary: TraceSummary,
): HierarchyNode[] {
  const previousCost = previousSummary?.costUsd ?? 0;
  const nextCost = nextSummary.costUsd ?? 0;
  const costDelta = roundCostUsd(nextCost - previousCost);

  return nodes.map((node) =>
    patchHierarchyNode(node, traceId, previousSummary, nextSummary, costDelta),
  );
}

function patchHierarchyNode(
  node: HierarchyNode,
  traceId: string,
  previousSummary: TraceSummary | null,
  nextSummary: TraceSummary,
  costDelta: number,
): HierarchyNode {
  const containsTrace = node.traceIds.includes(traceId);
  const nextChildren = node.children.map((child) =>
    patchHierarchyNode(child, traceId, previousSummary, nextSummary, costDelta),
  );
  const childrenChanged = nextChildren.some(
    (child, index) => child !== node.children[index],
  );

  if (!containsTrace && !childrenChanged) {
    return node;
  }

  const nextMeta = { ...node.meta };
  let nextLabel = node.label;

  if (containsTrace) {
    if (node.type === "trace" && node.meta.traceId === traceId) {
      nextMeta.costUsd = nextSummary.costUsd;
      nextMeta.model = nextSummary.model;
      nextMeta.provider = nextSummary.provider;
      nextMeta.status = nextSummary.status;
      nextLabel = nextSummary.model
        ? `${nextSummary.model} ${nextSummary.mode}`
        : traceId;
    } else if (
      costDelta !== 0 ||
      previousSummary?.costUsd !== null ||
      nextSummary.costUsd !== null
    ) {
      const currentCost =
        typeof nextMeta.costUsd === "number" &&
        Number.isFinite(nextMeta.costUsd)
          ? nextMeta.costUsd
          : 0;
      nextMeta.costUsd = roundCostUsd(currentCost + costDelta);
    }
  }

  if (
    !childrenChanged &&
    nextLabel === node.label &&
    shallowEqualMeta(node.meta, nextMeta)
  ) {
    return node;
  }

  return {
    ...node,
    children: nextChildren,
    label: nextLabel,
    meta: nextMeta,
  };
}

function shallowEqualMeta(
  left: Record<string, any>,
  right: Record<string, any>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every((key) => left[key] === right[key]);
}

function buildSelectionSummary(
  visibleCount: number,
  costUsd: number | null,
  selectedNodePath: HierarchyNode[],
  traceById: Map<string, TraceSummary>,
  filters: Filters,
): string {
  const scope = selectedNodePath.length
    ? selectedNodePath
        .map((node) => getHierarchyNodeCopy(node, traceById).label)
        .join(" / ")
    : null;
  const countLabel = formatCountLabel(visibleCount, "call");
  const scopeSummary = formatList([
    countLabel,
    formatCostSummaryLabel(costUsd, visibleCount > 1),
  ]);

  if (scope) {
    return `Showing ${scopeSummary} in ${scope}`;
  }

  if (filters.search || filters.status || filters.kind || filters.tags) {
    return `Showing ${scopeSummary} across the current filters`;
  }

  return `Showing ${scopeSummary} across all traces`;
}

function buildHierarchyTimelineModel(
  rootNode: HierarchyNode | null,
  traceById: Map<string, TraceSummary>,
  selectedNodeId: string | null,
  selectedNodePath: HierarchyNode[],
  selectedTraceId: string | null,
): HierarchyTimelineModel | null {
  if (!rootNode) {
    return null;
  }

  const nowMs = Date.now();
  const timingCache = new Map<
    string,
    {
      durationMs: number;
      endMs: number;
      startMs: number;
      startedAt: string;
    } | null
  >();
  const getTiming = (node: HierarchyNode) => {
    if (!timingCache.has(node.id)) {
      timingCache.set(
        node.id,
        resolveHierarchyNodeTiming(node, traceById, nowMs),
      );
    }

    return timingCache.get(node.id) ?? null;
  };

  const rootTiming = getTiming(rootNode);
  if (!rootTiming) {
    return null;
  }

  const pathIds = new Set(selectedNodePath.map((node) => node.id));
  const rows: HierarchyTimelineRow[] = [];

  const visit = (
    node: HierarchyNode,
    depth: number,
    ancestorContinuations: boolean[],
    isLastSibling: boolean,
  ) => {
    const timing = getTiming(node);
    if (!timing) {
      return;
    }

    const copy = getHierarchyNodeCopy(node, traceById);
    const trace =
      node.type === "trace" && node.meta.traceId
        ? (traceById.get(node.meta.traceId) ?? null)
        : null;
    const children = node.children
      .slice()
      .sort((left, right) => compareHierarchyNodesForTimeline(left, right, getTiming));
    rows.push({
      ancestorContinuations,
      badge: copy.badge,
      costUsd: getHierarchyNodeCostUsd(node),
      depth,
      durationMs: timing.durationMs,
      hasHighlights: Boolean(trace?.flags?.hasHighlights),
      hasStructuredInput: Boolean(trace?.flags?.hasStructuredInput),
      hasVisibleChildren: children.length > 0,
      id: node.id,
      isActive: node.id === selectedNodeId,
      isDetailTrace: node.meta?.traceId === selectedTraceId,
      isInPath: pathIds.has(node.id),
      isLastSibling,
      label: copy.label,
      meta: copy.meta,
      offsetMs: Math.max(0, timing.startMs - rootTiming.startMs),
      startedAt: timing.startedAt,
      type: node.type,
    });

    for (const [index, child] of children.entries()) {
      visit(
        child,
        depth + 1,
        [...ancestorContinuations, !isLastSibling],
        index === children.length - 1,
      );
    }
  };

  visit(rootNode, 0, [], true);

  return {
    costUsd: getHierarchyNodeCostUsd(rootNode),
    durationMs: Math.max(rootTiming.durationMs, 1),
    rows,
    sessionLabel: getHierarchyNodeCopy(rootNode, traceById).label,
    startedAt: rootTiming.startedAt,
  };
}

function compareHierarchyNodesForTimeline(
  left: HierarchyNode,
  right: HierarchyNode,
  getTiming: (node: HierarchyNode) => {
    durationMs: number;
    endMs: number;
    startMs: number;
    startedAt: string;
  } | null,
): number {
  const leftTiming = getTiming(left);
  const rightTiming = getTiming(right);

  if (leftTiming && rightTiming && leftTiming.startMs !== rightTiming.startMs) {
    return leftTiming.startMs - rightTiming.startMs;
  }

  if (left.type !== right.type) {
    return left.type.localeCompare(right.type);
  }

  return left.label.localeCompare(right.label);
}

function resolveHierarchyNodeTiming(
  node: HierarchyNode,
  traceById: Map<string, TraceSummary>,
  nowMs: number,
): {
  durationMs: number;
  endMs: number;
  startMs: number;
  startedAt: string;
} | null {
  const seen = new Set<string>();
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  let startedAt = "";

  for (const traceId of node.traceIds) {
    if (!traceId || seen.has(traceId)) {
      continue;
    }

    seen.add(traceId);
    const trace = traceById.get(traceId);
    if (!trace) {
      continue;
    }

    const traceStartMs = Date.parse(trace.startedAt);
    if (!Number.isFinite(traceStartMs)) {
      continue;
    }

    const traceEndMs = resolveTraceEndMs(trace, nowMs, traceStartMs);
    if (traceStartMs < startMs) {
      startMs = traceStartMs;
      startedAt = trace.startedAt;
    }
    if (traceEndMs > endMs) {
      endMs = traceEndMs;
    }
  }

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return null;
  }

  return {
    durationMs: Math.max(1, endMs - startMs),
    endMs,
    startMs,
    startedAt,
  };
}

function resolveTraceEndMs(
  trace: TraceSummary,
  nowMs: number,
  traceStartMs: number,
): number {
  if (trace.endedAt) {
    const endedAtMs = Date.parse(trace.endedAt);
    if (Number.isFinite(endedAtMs)) {
      return endedAtMs;
    }
  }

  if (
    typeof trace.durationMs === "number" &&
    Number.isFinite(trace.durationMs)
  ) {
    return traceStartMs + Math.max(trace.durationMs, 1);
  }

  return nowMs;
}

function getTimelineTypeLabel(type: string): string {
  switch (type) {
    case "session":
      return "Session";
    case "actor":
      return "Actor";
    case "child-actor":
      return "Child actor";
    case "stage":
      return "Stage";
    case "guardrail":
      return "Guardrail";
    case "trace":
      return "Call";
    default:
      return startCase(type);
  }
}

function formatInsightSource(source: string): string {
  if (source.startsWith("request:")) {
    return `Request ${Number(source.split(":")[1] || 0) + 1}`;
  }

  if (source.startsWith("response:")) {
    return "Response";
  }

  if (source.startsWith("stream:")) {
    return "Stream";
  }

  if (source === "trace:guardrail") {
    return "Guardrail context";
  }

  return source;
}

function buildHierarchyTimelineRowTooltip(row: HierarchyTimelineRow): string {
  const parts = [
    `${row.label} (${getTimelineTypeLabel(row.type)})`,
    `Started ${formatTimelineTimestamp(row.startedAt)}`,
    `Duration ${formatElapsedLabel(row.durationMs)}`,
  ];

  if (row.hasStructuredInput) {
    parts.push("Structured input detected");
  } else if (row.hasHighlights) {
    parts.push("Trace insights available");
  }

  if (row.costUsd !== null) {
    parts.push(`Cost ${formatUsdCost(row.costUsd)}`);
  }

  if (row.meta) {
    parts.push(row.meta);
  }

  return parts.join("\n");
}

function formatTraceDuration(
  trace: Pick<TraceRecord, "endedAt" | "startedAt">,
): string {
  if (!trace.endedAt) {
    return "Running";
  }

  return `${Math.max(0, Date.parse(trace.endedAt) - Date.parse(trace.startedAt))} ms`;
}

function formatCountLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function mergeTagFilter(current: string, nextEntry: string): string {
  if (!current.trim()) {
    return nextEntry;
  }

  const existing = current
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (existing.includes(nextEntry)) {
    return current;
  }

  return [...existing, nextEntry].join(",");
}

function countTagFilters(value: string): number {
  if (!value.trim()) {
    return 0;
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean).length;
}

function countSessionNodes(nodes: HierarchyNode[]): number {
  return nodes.filter((node) => node.type === "session").length;
}

function getHierarchyNodeCostUsd(
  node: HierarchyNode | null | undefined,
): number | null {
  return typeof node?.meta?.costUsd === "number" &&
    Number.isFinite(node.meta.costUsd)
    ? node.meta.costUsd
    : null;
}

function getUsageCostUsd(
  usage: Record<string, any> | null | undefined,
): number | null {
  const promptTokens = toFiniteNumber(usage?.tokens?.prompt);
  const completionTokens = toFiniteNumber(usage?.tokens?.completion);
  const promptPricing = toFiniteNumber(usage?.pricing?.prompt);
  const completionPricing = toFiniteNumber(usage?.pricing?.completion);

  if (
    promptTokens === null ||
    completionTokens === null ||
    promptPricing === null ||
    completionPricing === null
  ) {
    return null;
  }

  return roundCostUsd(
    promptTokens * promptPricing + completionTokens * completionPricing,
  );
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function roundCostUsd(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

function formatUsdCost(costUsd: number | null | undefined): string | null {
  if (costUsd === null || costUsd === undefined || !Number.isFinite(costUsd)) {
    return null;
  }

  if (costUsd > 0 && costUsd < 0.0001) {
    return "<US$0.0001";
  }

  if (costUsd >= 10) {
    return `US$${costUsd.toFixed(2)}`;
  }

  if (costUsd >= 1) {
    return `US$${costUsd.toFixed(3)}`;
  }

  return `US$${costUsd.toFixed(4)}`;
}

function formatCostSummaryLabel(
  costUsd: number | null | undefined,
  aggregate = false,
): string | null {
  const formatted = formatUsdCost(costUsd);
  if (!formatted) {
    return null;
  }

  return aggregate ? `Σ ${formatted}` : formatted;
}

function formatDurationText(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)} s`;
  }

  return `${value} ms`;
}

function createMetadataEntry(
  label: string,
  rawValue: string | null | undefined,
  options: { filterKey?: string; monospace?: boolean } = {},
): MetadataEntry | null {
  if (!rawValue) {
    return null;
  }

  return {
    copyValue: rawValue,
    filterKey: options.filterKey ?? label,
    filterValue: rawValue,
    label,
    monospace: options.monospace ?? looksLikeIdentifier(rawValue),
    value: rawValue,
  };
}

function createNumberMetadataEntry(
  label: string,
  rawValue: number | null | undefined,
  secondary?: string,
): MetadataEntry | null {
  if (
    rawValue === null ||
    rawValue === undefined ||
    !Number.isFinite(rawValue)
  ) {
    return null;
  }

  return {
    copyValue: String(rawValue),
    label,
    monospace: false,
    secondary,
    value: rawValue.toLocaleString(),
  };
}

function createCurrencyMetadataEntry(
  label: string,
  rawValue: number | null | undefined,
  secondary?: string,
): MetadataEntry | null {
  if (
    rawValue === null ||
    rawValue === undefined ||
    !Number.isFinite(rawValue)
  ) {
    return null;
  }

  return {
    copyValue: String(rawValue),
    label,
    monospace: false,
    secondary,
    value: formatUsdCost(rawValue) ?? "US$0.0000",
  };
}

function getUsageSegmentCostUsd(
  usage: Record<string, any> | null | undefined,
  segment: "completion" | "prompt",
): number | null {
  const tokens = toFiniteNumber(usage?.tokens?.[segment]);
  const pricing = toFiniteNumber(usage?.pricing?.[segment]);

  if (tokens === null || pricing === null) {
    return null;
  }

  return roundCostUsd(tokens * pricing);
}

function formatPricingRate(value: unknown): string | undefined {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return undefined;
  }

  if (numeric >= 0.01) {
    return `US$${numeric.toFixed(4)} / token`;
  }

  if (numeric >= 0.0001) {
    return `US$${numeric.toFixed(6)} / token`;
  }

  return `US$${numeric.toExponential(2)} / token`;
}

function formatTimestampDetails(value: string): {
  primary: string;
  secondary: string;
} {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { primary: value, secondary: value };
  }

  return {
    primary: date.toLocaleString([], {
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      month: "short",
      second: "2-digit",
      year: "numeric",
    }),
    secondary: value,
  };
}

function formatInspectorValue(value: string): string {
  return looksLikeIdentifier(value) ? truncateInspectorValue(value) : value;
}

function truncateInspectorValue(value: string): string {
  if (value.length <= 18) {
    return value;
  }

  if (value.includes("|")) {
    const [prefix, rest] = value.split("|", 2);
    if (rest) {
      return `${prefix}|${rest.slice(0, 6)}...${rest.slice(-4)}`;
    }
  }

  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function looksLikeIdentifier(value: string): boolean {
  return (
    value.length > 18 &&
    (/^[\w|-]+$/i.test(value) || value.includes("-") || value.includes("|"))
  );
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (_error) {
    // fall through to textarea fallback
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(textarea);
    return copied;
  } catch (_error) {
    return false;
  }
}

function toSessionNodeId(sessionId: string): string {
  return `session:${sessionId}`;
}

function toTraceNodeId(traceId: string): string {
  return `trace:${traceId}`;
}

function shortId(value: string): string {
  if (!value) {
    return "unknown";
  }

  return value.length > 8 ? value.slice(0, 8) : value;
}

function startCase(value: string): string {
  return value
    .split(/[\s-_]+/)
    .filter(Boolean)
    .map((part) => capitalize(part))
    .join(" ");
}

function capitalize(value: string): string {
  if (!value) {
    return "";
  }

  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function getResponseMessage(
  detail: TraceRecord,
): { content: any; role: string } | null {
  if (detail.response?.message) {
    return detail.response.message as { content: any; role: string };
  }

  if (detail.stream?.reconstructed?.message) {
    return detail.stream.reconstructed.message as {
      content: any;
      role: string;
    };
  }

  return null;
}

function getToolCalls(detail: TraceRecord): any[] {
  if (Array.isArray(detail.response?.tool_calls)) {
    return detail.response.tool_calls;
  }

  if (Array.isArray(detail.stream?.reconstructed?.tool_calls)) {
    return detail.stream.reconstructed.tool_calls;
  }

  return [];
}

function getUsage(detail: TraceRecord): Record<string, any> | null {
  if (detail.response?.usage) {
    return detail.response.usage as Record<string, any>;
  }

  if (detail.stream?.reconstructed?.usage) {
    return detail.stream.reconstructed.usage as Record<string, any>;
  }

  return null;
}

function getMessageToolCalls(message: any): any[] {
  if (Array.isArray(message?.tool_calls)) {
    return message.tool_calls;
  }

  if (Array.isArray(message?.toolCalls)) {
    return message.toolCalls;
  }

  return [];
}

function getToolCallName(toolCall: any, index: number): string {
  if (typeof toolCall?.name === "string" && toolCall.name) {
    return toolCall.name;
  }

  if (typeof toolCall?.function?.name === "string" && toolCall.function.name) {
    return toolCall.function.name;
  }

  if (typeof toolCall?.toolName === "string" && toolCall.toolName) {
    return toolCall.toolName;
  }

  return toolCall?.type || `tool-${index + 1}`;
}

function getToolCallArguments(toolCall: any): any {
  if (toolCall?.function?.arguments !== undefined) {
    return parseMaybeJson(toolCall.function.arguments);
  }

  if (toolCall?.arguments !== undefined) {
    return parseMaybeJson(toolCall.arguments);
  }

  if (toolCall?.args !== undefined) {
    return parseMaybeJson(toolCall.args);
  }

  return {};
}

function parseMaybeJson(value: any): any {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function buildStreamTimelineModel(detail: TraceRecord): {
  buckets: number[];
  chunkCount: number;
  firstChunkMs: number | null;
  maxBucket: number;
  segments: Array<{ offsetMs: number; text: string }>;
  totalDurationMs: number | null;
} {
  const stream = detail.stream;
  if (!stream) {
    return {
      buckets: [],
      chunkCount: 0,
      firstChunkMs: null,
      maxBucket: 1,
      segments: [],
      totalDurationMs: null,
    };
  }

  const chunkEvents = stream.events.filter(
    (event) =>
      event?.type === "chunk" &&
      typeof event?.content === "string" &&
      event.content.trim().length > 0,
  );
  const lastOffsetMs = chunkEvents.length
    ? chunkEvents.reduce(
        (max, event, index) =>
          Math.max(
            max,
            resolveStreamEventOffset(event, index, chunkEvents.length, null) ??
              0,
          ),
        0,
      )
    : null;
  const totalDurationMs = detail.endedAt
    ? Math.max(0, Date.parse(detail.endedAt) - Date.parse(detail.startedAt))
    : lastOffsetMs;
  const bucketCount = chunkEvents.length
    ? Math.min(48, Math.max(16, chunkEvents.length))
    : 0;
  const buckets = Array.from({ length: bucketCount }, () => 0);

  if (chunkEvents.length && bucketCount > 0) {
    const effectiveDuration = Math.max(
      totalDurationMs ?? lastOffsetMs ?? chunkEvents.length,
      1,
    );
    for (const [index, event] of chunkEvents.entries()) {
      const offsetMs =
        resolveStreamEventOffset(
          event,
          index,
          chunkEvents.length,
          effectiveDuration,
        ) ?? 0;
      const bucketIndex = Math.min(
        bucketCount - 1,
        Math.floor((offsetMs / effectiveDuration) * bucketCount),
      );
      buckets[bucketIndex] += Math.max(
        1,
        Math.ceil(String(event.content).length / 12),
      );
    }
  }

  return {
    buckets,
    chunkCount: stream.chunkCount,
    firstChunkMs: stream.firstChunkMs,
    maxBucket: Math.max(1, ...buckets),
    segments: buildStreamTextSegments(chunkEvents, totalDurationMs),
    totalDurationMs,
  };
}

function resolveStreamEventOffset(
  event: Record<string, any>,
  index: number,
  totalEvents: number,
  fallbackDurationMs: number | null,
): number | null {
  if (typeof event?.offsetMs === "number" && Number.isFinite(event.offsetMs)) {
    return Math.max(0, event.offsetMs);
  }

  if (fallbackDurationMs === null) {
    return null;
  }

  if (totalEvents <= 1) {
    return 0;
  }

  return Math.round(
    (index / Math.max(1, totalEvents - 1)) * fallbackDurationMs,
  );
}

function buildStreamTextSegments(
  chunkEvents: Array<Record<string, any>>,
  totalDurationMs: number | null,
): Array<{ offsetMs: number; text: string }> {
  const segments: Array<{
    chunkCount: number;
    lastOffsetMs: number;
    offsetMs: number;
    text: string;
  }> = [];

  for (const [index, event] of chunkEvents.entries()) {
    const content = typeof event.content === "string" ? event.content : "";
    if (!content) {
      continue;
    }

    const offsetMs =
      resolveStreamEventOffset(
        event,
        index,
        chunkEvents.length,
        totalDurationMs,
      ) ?? 0;
    const previous = segments[segments.length - 1];
    const gapMs = previous ? offsetMs - previous.lastOffsetMs : 0;
    const shouldBreak =
      !previous ||
      gapMs > 220 ||
      previous.chunkCount >= 10 ||
      previous.text.length >= 180 ||
      /[\n\r]/.test(content);

    if (shouldBreak) {
      segments.push({
        chunkCount: 1,
        lastOffsetMs: offsetMs,
        offsetMs,
        text: content,
      });
      continue;
    }

    previous.chunkCount += 1;
    previous.lastOffsetMs = offsetMs;
    previous.text += content;
  }

  return segments.map((segment) => ({
    offsetMs: segment.offsetMs,
    text: segment.text.trim() || segment.text,
  }));
}

function detectJsonValue(content: any): any | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed);
      return isJsonCompoundValue(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  if (!content || typeof content !== "object") {
    return null;
  }

  if (toMarkdownText(content) !== null) {
    return null;
  }

  return content;
}

function isJsonCompoundValue(value: any): boolean {
  return Array.isArray(value) || (!!value && typeof value === "object");
}

function messageListHasToolCall(messages: Array<any>, toolCall: any): boolean {
  return messages.some((message) =>
    getMessageToolCalls(message).some((candidate: any) =>
      isSameToolCall(candidate, toolCall),
    ),
  );
}

function isSameToolCall(left: any, right: any): boolean {
  if (left?.id && right?.id) {
    return left.id === right.id;
  }

  return (
    getToolCallName(left, 0) === getToolCallName(right, 0) &&
    JSON.stringify(getToolCallArguments(left)) ===
      JSON.stringify(getToolCallArguments(right))
  );
}

function toMarkdownText(content: any): string | null {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts = content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (typeof item?.text === "string") {
          return item.text;
        }

        if (typeof item?.text?.value === "string") {
          return item.text.value;
        }

        if (typeof item?.content === "string") {
          return item.content;
        }

        return "";
      })
      .filter(Boolean);

    return textParts.length ? textParts.join("\n\n") : null;
  }

  if (typeof content?.text === "string") {
    return content.text;
  }

  if (typeof content?.text?.value === "string") {
    return content.text.value;
  }

  if (typeof content?.content === "string") {
    return content.content;
  }

  return null;
}

function extractPlainMessageText(content: any): string | null {
  const markdown = toMarkdownText(content);
  if (markdown !== null) {
    return markdown;
  }

  if (typeof content === "string") {
    return content;
  }

  return null;
}

function detectStructuredMarkup(
  text: string,
): { tags: string[]; tokens: Array<{ type: string; value: string }> } | null {
  const tagRegex = /<\/?([A-Za-z][\w:-]*)\b[^>]*>/g;
  const tagNames = [...text.matchAll(tagRegex)].map((match) =>
    match[1].toLowerCase(),
  );
  const tags = [...new Set(tagNames)].slice(0, 6);

  if (!tags.length) {
    return null;
  }

  const hasInstructionalTag = tags.some((tag) =>
    [
      "assistant",
      "instruction",
      "option",
      "policy",
      "system",
      "user",
    ].includes(tag),
  );
  const hasMultipleTags = tags.length >= 2;
  const hasClosingTag = /<\/[A-Za-z][\w:-]*>/.test(text);

  if (!hasClosingTag && !hasInstructionalTag && !hasMultipleTags) {
    return null;
  }

  return {
    tags: tags.slice(0, 4),
    tokens: tokenizeStructuredMarkup(text),
  };
}

function tokenizeStructuredMarkup(
  text: string,
): Array<{ type: string; value: string }> {
  const parts = text.split(/(<\/?[\w:-]+\b[^>]*\/?>)/g).filter(Boolean);
  const tokens: Array<{ type: string; value: string }> = [];

  for (const part of parts) {
    if (!part.startsWith("<")) {
      tokens.push({ type: "text", value: part });
      continue;
    }

    const tagMatch = part.match(/^(<\/?)([\w:-]+)(.*?)(\/?>)$/s);
    if (!tagMatch) {
      tokens.push({ type: "tag-punctuation", value: part });
      continue;
    }

    const [, open, tagName, attributesPart, close] = tagMatch;
    tokens.push({ type: "tag-punctuation", value: open });
    tokens.push({ type: "tag-name", value: tagName });

    const attrRegex = /(\s+)([\w:-]+)(\s*=\s*)?(".*?"|'.*?'|[^\s"'=<>`]+)?/gs;
    let lastIndex = 0;
    let attrMatch = attrRegex.exec(attributesPart);
    while (attrMatch) {
      const [full, leadingSpace, attrName, separator = "", attrValue = ""] =
        attrMatch;
      if (attrMatch.index > lastIndex) {
        tokens.push({
          type: "text",
          value: attributesPart.slice(lastIndex, attrMatch.index),
        });
      }
      tokens.push({ type: "text", value: leadingSpace });
      tokens.push({ type: "attr-name", value: attrName });
      if (separator) {
        tokens.push({ type: "attr-punctuation", value: separator });
      }
      if (attrValue) {
        tokens.push({ type: "attr-value", value: attrValue });
      }
      lastIndex = attrMatch.index + full.length;
      attrMatch = attrRegex.exec(attributesPart);
    }
    if (lastIndex < attributesPart.length) {
      tokens.push({
        type: "text",
        value: attributesPart.slice(lastIndex),
      });
    }

    tokens.push({ type: "tag-punctuation", value: close });
  }

  return tokens;
}

function getMessageCollapseText(
  content: any,
  jsonValue: any,
  markdown: string | null,
): string {
  if (jsonValue !== null) {
    return JSON.stringify(jsonValue, null, 2) || "";
  }

  if (markdown !== null) {
    return markdown;
  }

  return JSON.stringify(content, null, 2) || "";
}

function shouldCollapseMessage(text: string, role?: string): boolean {
  if (!text) {
    return false;
  }

  if (role === "system") {
    if (text.length > MESSAGE_COLLAPSE_CHAR_LIMIT_SYSTEM) {
      return true;
    }

    return countLines(text) > MESSAGE_COLLAPSE_LINE_LIMIT_SYSTEM;
  }

  if (text.length > MESSAGE_COLLAPSE_CHAR_LIMIT) {
    return true;
  }

  return countLines(text) > MESSAGE_COLLAPSE_LINE_LIMIT;
}

function formatCollapsedSummary(text: string): string | null {
  const trimmed = text.trim();

  if (!trimmed) {
    return null;
  }

  const lineCount = countLines(trimmed);
  const parts: string[] = [];

  if (lineCount > 1) {
    parts.push(`${lineCount.toLocaleString()} lines`);
  }

  parts.push(`${trimmed.length.toLocaleString()} chars`);
  parts.push(`~${formatCompactCount(estimateTokenCount(trimmed))} tok`);

  return parts.join(" · ");
}

function estimateTokenCount(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

function countLines(text: string): number {
  let lines = 1;

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      lines += 1;
    }
  }

  return lines;
}

function tokenizeJson(json: string): ReactNode[] {
  const tokenPattern =
    /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null = null;

  while ((match = tokenPattern.exec(json)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(json.slice(lastIndex, match.index));
    }

    const token = match[0];
    const nextChar = json[match.index + token.length];
    let className = "json-token json-token-string";

    if (token.startsWith('"') && nextChar === ":") {
      className = "json-token json-token-key";
    } else if (token === "true" || token === "false") {
      className = "json-token json-token-boolean";
    } else if (token === "null") {
      className = "json-token json-token-null";
    } else if (!token.startsWith('"')) {
      className = "json-token json-token-number";
    }

    nodes.push(
      <span key={`${match.index}-${token}`} className={className}>
        {token}
      </span>,
    );
    lastIndex = match.index + token.length;
  }

  if (lastIndex < json.length) {
    nodes.push(json.slice(lastIndex));
  }

  return nodes;
}

function hasRenderableContent(content: any): boolean {
  if (content === null || content === undefined) {
    return false;
  }

  if (typeof content === "string") {
    return content.trim().length > 0;
  }

  if (Array.isArray(content)) {
    return content.some((item) =>
      hasRenderableContent(
        item?.text?.value ?? item?.text ?? item?.content ?? item,
      ),
    );
  }

  if (typeof content === "object") {
    return Boolean(toMarkdownText(content)) || Object.keys(content).length > 0;
  }

  return true;
}

function formatList(values: Array<string | null | undefined>) {
  return values.filter(Boolean).join(" · ");
}

function formatCompactCount(value: number): string {
  if (value < 1000) {
    return value.toLocaleString();
  }

  return new Intl.NumberFormat([], {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(value);
}

function getSemanticBadgeValue(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }

  switch (value.trim().toLowerCase()) {
    case "session":
      return "session";
    case "actor":
      return "actor";
    case "assistant":
      return "assistant";
    case "user":
      return "user";
    case "system":
      return "system";
    case "tool":
      return "tool";
    case "tool call":
    case "tool-call":
      return "tool-call";
    case "guardrail":
      return "guardrail";
    case "call":
      return "call";
    case "child actor":
    case "child-actor":
      return "child-actor";
    case "stage":
      return "stage";
    default:
      return null;
  }
}

function formatCompactTimestamp(value: string) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTimelineTimestamp(value: string) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function getMaxDurationMs(items: Array<{ durationMs: number | null }>): number {
  const durations = items
    .map((item) => item.durationMs)
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value) && value > 0,
    );
  return durations.length ? Math.max(...durations) : 1;
}

function getElapsedScale(
  durationMs: number | null,
  maxDurationMs: number,
): number {
  if (durationMs === null || durationMs <= 0 || !Number.isFinite(durationMs)) {
    return 0.16;
  }

  const safeMax = Math.max(maxDurationMs, durationMs, 1);
  const ratio = Math.log1p(durationMs) / Math.log1p(safeMax);
  return Math.max(0.14, Math.min(1, ratio));
}

function formatElapsedLabel(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs)) {
    return "Running";
  }

  if (durationMs >= 60_000) {
    return `${(durationMs / 60_000).toFixed(2)} m`;
  }

  if (durationMs >= 1_000) {
    return `${(durationMs / 1_000).toFixed(2)} s`;
  }

  if (durationMs >= 100) {
    return `${durationMs.toFixed(0)} ms`;
  }

  return `${durationMs.toFixed(2)} ms`;
}

function cn(...values: Array<string | false | null | undefined>) {
  return clsx(values);
}

function Button({
  children,
  className,
  onClick,
  variant = "default",
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  variant?: "default" | "outline";
}) {
  return (
    <button
      type="button"
      className={cn("ui-button", `ui-button-${variant}`, className)}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Badge({
  children,
  className,
  semantic,
  variant = "secondary",
}: {
  children: ReactNode;
  className?: string;
  semantic?: string;
  variant?: "destructive" | "outline" | "secondary" | "success" | "warning";
}) {
  const semanticValue = getSemanticBadgeValue(
    semantic ?? (typeof children === "string" ? children : null),
  );

  return (
    <span
      className={cn("ui-badge", `ui-badge-${variant}`, className)}
      data-semantic={semanticValue ?? undefined}
    >
      {children}
    </span>
  );
}

function BadgeButton({
  children,
  className,
  onClick,
  semantic,
  title,
  variant = "secondary",
}: {
  children: ReactNode;
  className?: string;
  onClick: () => void;
  semantic?: string;
  title?: string;
  variant?: "destructive" | "outline" | "secondary" | "success" | "warning";
}) {
  const semanticValue = semantic?.toLowerCase();
  return (
    <button
      type="button"
      className={cn(
        "ui-badge",
        `ui-badge-${variant}`,
        "ui-badge-button",
        className,
      )}
      data-semantic={semanticValue ?? undefined}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}

function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={cn("ui-card", className)}>{children}</section>;
}

function CardHeader({ children }: { children: ReactNode }) {
  return <div className="ui-card-header">{children}</div>;
}

function CardTitle({ children }: { children: ReactNode }) {
  return <h2 className="ui-card-title">{children}</h2>;
}

function CardDescription({ children }: { children: ReactNode }) {
  return <p className="ui-card-description">{children}</p>;
}

function CardContent({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("ui-card-content", className)}>{children}</div>;
}

function FilterField({
  icon: Icon,
  label,
  onChange,
  placeholder,
  value,
}: {
  icon: typeof Search;
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  const inputId = useId();

  return (
    <label className="filter-field" htmlFor={inputId}>
      <span className="filter-label">{label}</span>
      <div className="filter-input-shell">
        <Icon data-icon="inline-start" />
        <input
          id={inputId}
          className="ui-input"
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </label>
  );
}

function SelectField({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ label: string; value: string }>;
  value: string;
}) {
  const selectId = useId();

  return (
    <label className="filter-field" htmlFor={selectId}>
      <span className="filter-label">{label}</span>
      <select
        id={selectId}
        className="ui-select"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.label} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Separator() {
  return <div className="ui-separator" aria-hidden="true" />;
}

function Tabs({
  children,
  onChange,
  value,
}: {
  children: ReactNode;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <div
      className="tabs-root"
      data-value={value}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        const trigger = target.closest(
          "[data-tab-value]",
        ) as HTMLElement | null;
        if (trigger?.dataset.tabValue) {
          onChange(trigger.dataset.tabValue);
        }
      }}
    >
      {children}
    </div>
  );
}

function TabsList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("tabs-list", className)}>{children}</div>;
}

function TabsTrigger({
  children,
  value,
}: {
  children: ReactNode;
  value: string;
}) {
  return (
    <button type="button" className="tabs-trigger" data-tab-value={value}>
      {children}
    </button>
  );
}

function parseEvent(data: string): TraceEventPayload | null {
  try {
    return JSON.parse(data) as TraceEventPayload;
  } catch {
    return null;
  }
}
