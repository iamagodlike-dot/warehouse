import { useState, useEffect, useRef } from "react";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc, collection, getDocs } from "firebase/firestore";
import QRCode from "qrcode";

const firebaseApp = initializeApp({
  apiKey: "AIzaSyCYK7Jftv6LcgiGqxDkH0IcWHIqb5tcXUQ",
  authDomain: "warehouse-a1b6c.firebaseapp.com",
  projectId: "warehouse-a1b6c",
  storageBucket: "warehouse-a1b6c.firebasestorage.app",
  messagingSenderId: "108353420882",
  appId: "1:108353420882:web:d359e2b2602403b3eca98b"
});
const db = getFirestore(firebaseApp);

const DEFAULT_CONFIG = { zones: [{ id: "A", label: "Зона A", rows: 4, cols: 6 }], staleDays: 7 };

async function sbGet(table, id) {
  const snap = await getDoc(doc(db, table, id));
  return snap.exists() ? snap.data() : null;
}

async function sbUpsert(table, id, data) {
  await setDoc(doc(db, table, id), data);
}

async function sbGetAllCells() {
  const snap = await getDocs(collection(db, "cells"));
  const obj = {};
  snap.forEach(d => { obj[d.id] = d.data(); });
  return obj;
}

async function addLog(action, cellId, details) {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await setDoc(doc(db, "log", id), { action, cellId, details, ts: Date.now() });
}

async function sbGetLog() {
  const snap = await getDocs(collection(db, "log"));
  const arr = [];
  snap.forEach(d => arr.push(d.data()));
  arr.sort((a, b) => b.ts - a.ts);
  return arr.slice(0, 200);
}

function cellId(zoneId, row, col) {
  return `${zoneId}-${String(row + 1).padStart(2, "0")}-${String(col + 1).padStart(2, "0")}`;
}

function parseCellId(id, config) {
  const m = id.match(/^(.+)-(\d+)-(\d+)$/);
  if (!m) return null;
  const zone = config.zones.find(z => z.id === m[1]);
  if (!zone) return null;
  return { zone, row: +m[2] - 1, col: +m[3] - 1 };
}

function daysOpen(openedAt) {
  if (!openedAt) return 0;
  const [d, mo, y] = openedAt.split(".").map(Number);
  if (!d || !mo || !y) return 0;
  return Math.floor((Date.now() - new Date(y, mo - 1, d).getTime()) / 86400000);
}

export default function App() {
  const [cells, setCells] = useState({});
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [view, setView] = useState("grid");
  const [modal, setModal] = useState(null);
  const [printCell, setPrintCell] = useState(null);
  const [archiveCell, setArchiveCell] = useState(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [newZone, setNewZone] = useState({ label: "", rows: 3, cols: 5, customId: "" });
  const [labelModal, setLabelModal] = useState(null);
  const [logEntries, setLogEntries] = useState([]);
  const [logLoading, setLogLoading] = useState(false);
  const pollRef = useRef(null);
  const urlOpenedRef = useRef(false);

  const loadAll = async () => {
    try {
      const [cfg, cls] = await Promise.all([sbGet("config", "main"), sbGetAllCells()]);
      if (cfg) setConfig(cfg);
      setCells(cls);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const loadLog = async () => {
    setLogLoading(true);
    try { setLogEntries(await sbGetLog()); } catch (e) { console.error(e); }
    setLogLoading(false);
  };

  useEffect(() => {
    loadAll();
    pollRef.current = setInterval(loadAll, 8000);
    return () => clearInterval(pollRef.current);
  }, []);

  useEffect(() => {
    if (view === "log") loadLog();
  }, [view]);

  useEffect(() => {
    if (loading || urlOpenedRef.current) return;
    urlOpenedRef.current = true;
    const cellParam = new URLSearchParams(window.location.search).get("cell");
    if (!cellParam) return;
    const parsed = parseCellId(cellParam, config);
    if (parsed) openCell(cellParam, parsed.zone, parsed.row, parsed.col);
  }, [loading]);

  const saveConfig = async (cfg) => {
    setConfig(cfg);
    setSyncing(true);
    await sbUpsert("config", "main", cfg);
    setSyncing(false);
  };

  const saveCell = async (id, data) => {
    const updated = { ...data, openedAt: data.openedAt || new Date().toLocaleDateString("ru-RU") };
    setCells(prev => ({ ...prev, [id]: updated }));
    setModal(null);
    setSyncing(true);
    await sbUpsert("cells", id, updated);
    await addLog("Изменена", id, `${updated.car || "—"} · ${updated.orderNum || "—"}`);
    setSyncing(false);
  };

  const freeCell = async (id) => {
    const cell = cells[id];
    if (!cell) return;
    const archive = cell._archive || [];
    const updated = { _archive: [...archive, { ...cell, freedAt: new Date().toLocaleDateString("ru-RU") }] };
    setCells(prev => ({ ...prev, [id]: updated }));
    setModal(null);
    setArchiveCell(null);
    setSyncing(true);
    await sbUpsert("cells", id, updated);
    await addLog("Освобождена", id, `${cell.car || "—"} · ${cell.orderNum || "—"}`);
    setSyncing(false);
  };

  const openCell = (id, zone, row, col) => {
    setModal({ id, zone, row, col, cell: cells[id] || null });
  };

  const allCells = config.zones.flatMap(z =>
    Array.from({ length: z.rows }, (_, r) =>
      Array.from({ length: z.cols }, (_, c) => {
        const id = cellId(z.id, r, c);
        return { id, zone: z, row: r, col: c, data: cells[id] };
      })
    ).flat()
  );

  const occupied = allCells.filter(c => c.data?.orderNum).length;
  const total = allCells.length;
  const filtered = search.trim()
    ? allCells.filter(c => {
        const s = search.toLowerCase();
        return c.id.toLowerCase().includes(s) ||
          c.data?.car?.toLowerCase().includes(s) ||
          c.data?.orderNum?.toLowerCase().includes(s) ||
          c.data?.parts?.some(p => p.name?.toLowerCase().includes(s) || p.article?.toLowerCase().includes(s));
      })
    : [];

  if (loading) return (
    <div style={{ minHeight: "100vh", background: "#0f0f0f", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16 }}>
      <img src="/logo-mark-white.png" style={{ width: 48, height: 48 }} />
      <div style={{ color: "#aaa", fontFamily: "monospace", letterSpacing: 2, fontSize: 13 }}>ЗАГРУЗКА СКЛАДА...</div>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: "#fafaf8", fontFamily: "'IBM Plex Sans','Helvetica Neue',sans-serif", color: "#1a1a1a" }}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />

      <header style={{ background: "#0f0f0f", color: "#fff", padding: "0 2rem", display: "flex", alignItems: "center", gap: "1rem", height: 60 }}>
        <img src="/logo-mark-white.png" style={{ width: 30, height: 30 }} />
        <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 500, fontSize: 14, letterSpacing: 2, textTransform: "uppercase" }}>СКЛАД ЗАПЧАСТЕЙ</span>
        <div style={{ flex: 1 }} />
        {syncing && <div style={{ fontSize: 12, color: "#666", fontFamily: "monospace" }}>⟳ сохранение...</div>}
        <div style={{ background: "#1e1e1e", borderRadius: 6, padding: "4px 14px", fontSize: 13, color: "#aaa" }}>
          <span style={{ color: occupied > 0 ? "#ff9800" : "#4caf50", fontWeight: 600 }}>{occupied}</span>
          <span style={{ color: "#555" }}> / {total} занято</span>
        </div>
        <button onClick={loadAll} style={{ background: "none", border: "1px solid #333", color: "#aaa", borderRadius: 6, padding: "5px 12px", cursor: "pointer", fontSize: 13 }} title="Обновить данные">↻</button>
        <button onClick={() => setConfigOpen(true)} style={{ background: "none", border: "1px solid #333", color: "#aaa", borderRadius: 6, padding: "5px 14px", cursor: "pointer", fontSize: 13 }}>⚙ Настройки</button>
      </header>

      <div style={{ background: "#fff", borderBottom: "1px solid #e8e8e8", display: "flex", padding: "0 2rem" }}>
        {[["grid", "🗺 Схема склада"], ["search", "🔍 Поиск"], ["stats", "📊 Статистика"], ["labels", "🖨 Печать"], ["log", "📋 Журнал"]].map(([key, label]) => (
          <button key={key} onClick={() => setView(key)} style={{
            background: "none", border: "none", borderBottom: view === key ? "2px solid #0f0f0f" : "2px solid transparent",
            padding: "14px 18px", cursor: "pointer", fontSize: 13, fontWeight: view === key ? 600 : 400,
            color: view === key ? "#0f0f0f" : "#666", transition: "all 0.15s"
          }}>{label}</button>
        ))}
      </div>

      <main style={{ padding: "2rem", maxWidth: 1200, margin: "0 auto" }}>
        {view === "grid" && <GridView config={config} cells={cells} onOpen={openCell} />}
        {view === "search" && <SearchView allCells={allCells} search={search} setSearch={setSearch} filtered={filtered} onOpen={openCell} onArchive={setArchiveCell} />}
        {view === "stats" && <StatsView config={config} allCells={allCells} onOpen={openCell} />}
        {view === "labels" && <LabelsView config={config} cells={cells} onPrint={setPrintCell} onLabelPrint={setLabelModal} />}
        {view === "log" && <LogView entries={logEntries} loading={logLoading} onRefresh={loadLog} />}
      </main>

      {modal && <CellModal modal={modal} config={config} onSave={saveCell} onFree={freeCell} onArchive={setArchiveCell} onClose={() => setModal(null)} />}
      {printCell && <PrintSheet cell={printCell} cells={cells} onClose={() => setPrintCell(null)} />}
      {archiveCell && <ArchiveModal cellId={archiveCell} cells={cells} onFree={freeCell} onClose={() => setArchiveCell(null)} />}
      {configOpen && <ConfigModal config={config} setConfig={saveConfig} newZone={newZone} setNewZone={setNewZone} onClose={() => setConfigOpen(false)} />}
      {labelModal && <LabelPrintModal zone={labelModal} onClose={() => setLabelModal(null)} />}
    </div>
  );
}

function GridView({ config, cells, onOpen }) {
  const staleDays = config.staleDays || 7;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2.5rem" }}>
      {config.zones.map(zone => (
        <div key={zone.id}>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1rem" }}>
            <div style={{ background: "#0f0f0f", color: "#fff", fontFamily: "'IBM Plex Mono',monospace", padding: "4px 14px", borderRadius: 4, fontSize: 13, letterSpacing: 1 }}>{zone.id}</div>
            <span style={{ fontWeight: 600, fontSize: 16 }}>{zone.label}</span>
            <span style={{ color: "#999", fontSize: 13 }}>{zone.rows} × {zone.cols}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${zone.cols}, 1fr)`, gap: 8 }}>
            {Array.from({ length: zone.rows }, (_, r) =>
              Array.from({ length: zone.cols }, (_, c) => {
                const id = cellId(zone.id, r, c);
                const data = cells[id];
                const isOccupied = data?.orderNum;
                const isStale = isOccupied && daysOpen(data.openedAt) >= staleDays;
                const color = isStale ? "#c62828" : isOccupied ? "#ff9800" : "#4caf50";
                const bg = isStale ? "#fdecea" : isOccupied ? "#fff8e1" : "#e8f5e9";
                return (
                  <button key={id} onClick={() => onOpen(id, zone, r, c)} style={{
                    border: `2px solid ${color}`,
                    background: bg,
                    borderRadius: 8, padding: "10px 8px", cursor: "pointer", textAlign: "left",
                    transition: "all 0.15s", minHeight: 80
                  }}>
                    <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, fontWeight: 600, color: isStale ? "#c62828" : isOccupied ? "#e65100" : "#2e7d32", marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}>
                      {isStale && <span title={`Стоит ${daysOpen(data.openedAt)} дн.`}>⚠</span>}{id}
                    </div>
                    {isOccupied ? (
                      <>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "#333", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{data.car}</div>
                        <div style={{ fontSize: 10, color: "#666", marginTop: 2 }}>{data.orderNum}</div>
                        <div style={{ fontSize: 10, color: isStale ? "#c62828" : "#999", marginTop: 2 }}>{data.parts?.length || 0} дет. · {daysOpen(data.openedAt)} дн.</div>
                      </>
                    ) : (
                      <div style={{ fontSize: 11, color: "#4caf50", marginTop: 4 }}>+ свободна</div>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function StatsView({ config, allCells, onOpen }) {
  const staleDays = config.staleDays || 7;
  const zoneStats = config.zones.map(z => {
    const zCells = allCells.filter(c => c.zone.id === z.id);
    const occ = zCells.filter(c => c.data?.orderNum);
    return { zone: z, total: zCells.length, occupied: occ.length };
  });
  const occupiedCells = allCells.filter(c => c.data?.orderNum);
  const avgDays = occupiedCells.length
    ? Math.round(occupiedCells.reduce((s, c) => s + daysOpen(c.data.openedAt), 0) / occupiedCells.length)
    : 0;
  const staleCells = occupiedCells
    .filter(c => daysOpen(c.data.openedAt) >= staleDays)
    .sort((a, b) => daysOpen(b.data.openedAt) - daysOpen(a.data.openedAt));

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: "2rem" }}>
        <div style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: 10, padding: "1.25rem" }}>
          <div style={{ fontSize: 11, color: "#999", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Занято ячеек</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{occupiedCells.length} <span style={{ fontSize: 15, color: "#999", fontWeight: 400 }}>/ {allCells.length}</span></div>
        </div>
        <div style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: 10, padding: "1.25rem" }}>
          <div style={{ fontSize: 11, color: "#999", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Средний срок хранения</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{avgDays} <span style={{ fontSize: 15, color: "#999", fontWeight: 400 }}>дн.</span></div>
        </div>
        <div style={{ background: staleCells.length ? "#fdecea" : "#fff", border: `1px solid ${staleCells.length ? "#f5c6c2" : "#e8e8e8"}`, borderRadius: 10, padding: "1.25rem" }}>
          <div style={{ fontSize: 11, color: staleCells.length ? "#c62828" : "#999", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Зависших (&gt;{staleDays} дн.)</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: staleCells.length ? "#c62828" : "#1a1a1a" }}>{staleCells.length}</div>
        </div>
      </div>

      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>По зонам</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: "2rem" }}>
        {zoneStats.map(({ zone, total, occupied }) => {
          const pct = total ? Math.round((occupied / total) * 100) : 0;
          return (
            <div key={zone.id} style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: 8, padding: "10px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                <div style={{ background: "#0f0f0f", color: "#fff", fontFamily: "'IBM Plex Mono',monospace", padding: "2px 10px", borderRadius: 4, fontSize: 12 }}>{zone.id}</div>
                <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{zone.label}</span>
                <span style={{ fontSize: 12, color: "#666" }}>{occupied} / {total} ({pct}%)</span>
              </div>
              <div style={{ height: 6, background: "#f0f0f0", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ width: `${pct}%`, height: "100%", background: pct > 80 ? "#e65100" : "#0f0f0f" }} />
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>Зависшие ячейки</div>
      {staleCells.length === 0 ? (
        <div style={{ color: "#999", fontSize: 13 }}>Нет ячеек с превышением срока хранения</div>
      ) : (
        staleCells.map(({ id, zone, row, col, data }) => (
          <div key={id} onClick={() => onOpen(id, zone, row, col)} style={{ background: "#fff", border: "1px solid #f5c6c2", borderRadius: 8, padding: "12px 16px", marginBottom: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: "1rem" }}>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, fontWeight: 600, background: "#c62828", color: "#fff", padding: "4px 10px", borderRadius: 4 }}>{id}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{data.car} · {data.orderNum}</div>
              <div style={{ color: "#666", fontSize: 12 }}>Открыта: {data.openedAt}</div>
            </div>
            <div style={{ color: "#c62828", fontWeight: 600, fontSize: 13 }}>{daysOpen(data.openedAt)} дн.</div>
          </div>
        ))
      )}
    </div>
  );
}

function LogView({ entries, loading, onRefresh }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: "1.5rem" }}>
        <div style={{ color: "#666", fontSize: 14 }}>Последние действия на складе</div>
        <div style={{ flex: 1 }} />
        <button onClick={onRefresh} style={{ background: "none", border: "1px solid #ddd", borderRadius: 6, padding: "5px 14px", cursor: "pointer", fontSize: 13 }}>↻ Обновить</button>
      </div>
      {loading ? (
        <div style={{ color: "#999", fontSize: 13 }}>Загрузка...</div>
      ) : entries.length === 0 ? (
        <div style={{ color: "#999", fontSize: 13 }}>Журнал пуст</div>
      ) : (
        entries.map((e, i) => (
          <div key={i} style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: 8, padding: "12px 16px", marginBottom: 8, display: "flex", alignItems: "center", gap: "1rem" }}>
            <div style={{ fontSize: 12, color: "#999", whiteSpace: "nowrap", fontFamily: "'IBM Plex Mono',monospace" }}>{new Date(e.ts).toLocaleString("ru-RU")}</div>
            <div style={{ fontSize: 12, fontWeight: 600, background: e.action === "Освобождена" ? "#e8f5e9" : "#fff8e1", color: e.action === "Освобождена" ? "#2e7d32" : "#e65100", padding: "3px 10px", borderRadius: 4 }}>{e.action}</div>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, fontWeight: 600 }}>{e.cellId}</div>
            <div style={{ flex: 1, fontSize: 13, color: "#666" }}>{e.details}</div>
          </div>
        ))
      )}
    </div>
  );
}

function SearchView({ allCells, search, setSearch, filtered, onOpen, onArchive }) {
  const occupied = allCells.filter(c => c.data?.orderNum);
  return (
    <div>
      <input value={search} onChange={e => setSearch(e.target.value)}
        placeholder="Поиск по ячейке, авто, заказ-наряду, детали, артикулу..."
        style={{ width: "100%", padding: "12px 16px", fontSize: 15, border: "1px solid #ddd", borderRadius: 8, outline: "none", boxSizing: "border-box" }} />
      {search.trim() ? (
        <div style={{ marginTop: "1.5rem" }}>
          <div style={{ color: "#666", fontSize: 13, marginBottom: 12 }}>Найдено: {filtered.length}</div>
          {filtered.map(({ id, zone, row, col, data }) => (
            <SearchRow key={id} id={id} zone={zone} row={row} col={col} data={data} onOpen={onOpen} onArchive={onArchive} />
          ))}
        </div>
      ) : (
        <div style={{ marginTop: "2rem" }}>
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 12 }}>Занятые ячейки ({occupied.length})</div>
          {occupied.map(({ id, zone, row, col, data }) => (
            <SearchRow key={id} id={id} zone={zone} row={row} col={col} data={data} onOpen={onOpen} onArchive={onArchive} />
          ))}
        </div>
      )}
    </div>
  );
}

function SearchRow({ id, zone, row, col, data, onOpen, onArchive }) {
  return (
    <div onClick={() => onOpen(id, zone, row, col)} style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: 8, padding: "14px 18px", marginBottom: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: "1rem" }}>
      <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, fontWeight: 600, background: data?.orderNum ? "#ff9800" : "#4caf50", color: "#fff", padding: "4px 10px", borderRadius: 4, whiteSpace: "nowrap" }}>{id}</div>
      {data?.orderNum ? (
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{data.car} · {data.orderNum}</div>
          <div style={{ color: "#666", fontSize: 13 }}>{data.parts?.map(p => p.name).filter(Boolean).join(", ")} · мастер: {data.master || "—"}</div>
        </div>
      ) : <div style={{ color: "#4caf50", fontSize: 13, flex: 1 }}>свободна</div>}
      <button onClick={e => { e.stopPropagation(); onArchive(id); }} style={{ background: "none", border: "1px solid #eee", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12, color: "#999" }}>Архив</button>
    </div>
  );
}

function LabelsView({ config, cells, onPrint, onLabelPrint }) {
  return (
    <div>
      <div style={{ color: "#666", fontSize: 14, marginBottom: "1.5rem" }}>Распечатайте лист ячейки или этикетки для склада</div>
      {config.zones.map(zone => (
        <div key={zone.id} style={{ marginBottom: "2rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1rem" }}>
            <div style={{ background: "#0f0f0f", color: "#fff", fontFamily: "'IBM Plex Mono',monospace", padding: "4px 14px", borderRadius: 4, fontSize: 13 }}>{zone.id}</div>
            <span style={{ fontWeight: 600 }}>{zone.label}</span>
            <button onClick={() => onLabelPrint(zone)} style={{ marginLeft: "auto", background: "#0f0f0f", color: "#fff", border: "none", borderRadius: 6, padding: "6px 16px", cursor: "pointer", fontSize: 13 }}>🖨 Этикетки зоны</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8 }}>
            {Array.from({ length: zone.rows }, (_, r) =>
              Array.from({ length: zone.cols }, (_, c) => {
                const id = cellId(zone.id, r, c);
                const data = cells[id];
                const isOccupied = data?.orderNum;
                return (
                  <div key={id} style={{ border: "1px solid #e8e8e8", borderRadius: 8, padding: 12, background: "#fff" }}>
                    <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, color: "#666", marginBottom: 6 }}>{id}</div>
                    {isOccupied && <div style={{ fontSize: 11, color: "#333", marginBottom: 6 }}>{data.car}</div>}
                    <button onClick={() => onPrint({ id, zone, row: r, col: c })} style={{ background: isOccupied ? "#fff8e1" : "#f5f5f5", border: `1px solid ${isOccupied ? "#ffcc02" : "#ddd"}`, borderRadius: 6, padding: "5px 10px", cursor: "pointer", fontSize: 11, width: "100%" }}>
                      {isOccupied ? "📄 Лист ячейки" : "📄 Пустой лист"}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

const inputSt = { border: "1px solid #e0e0e0", borderRadius: 6, padding: "7px 10px", fontSize: 13, outline: "none", width: "100%", boxSizing: "border-box" };

function CellModal({ modal, config, onSave, onFree, onArchive, onClose }) {
  const { id, cell } = modal;
  const isOccupied = cell?.orderNum;
  const [form, setForm] = useState({
    car: cell?.car || "", plate: cell?.plate || "", orderNum: cell?.orderNum || "",
    master: cell?.master || "", openedAt: cell?.openedAt || new Date().toLocaleDateString("ru-RU"),
    notes: cell?.notes || "", parts: cell?.parts || [{ name: "", article: "", qty: 1 }],
    _archive: cell?._archive || [],
  });

  const setPart = (i, field, val) => setForm(f => { const parts = [...f.parts]; parts[i] = { ...parts[i], [field]: val }; return { ...f, parts }; });
  const addPart = () => setForm(f => ({ ...f, parts: [...f.parts, { name: "", article: "", qty: 1 }] }));
  const removePart = (i) => setForm(f => ({ ...f, parts: f.parts.filter((_, idx) => idx !== i) }));

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "1rem" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, width: "100%", maxWidth: 640, maxHeight: "90vh", overflow: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        <div style={{ padding: "1.5rem", borderBottom: "1px solid #222", display: "flex", alignItems: "center", gap: "1rem", background: "#0f0f0f", borderRadius: "12px 12px 0 0" }}>
          <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 18, fontWeight: 600, color: "#fff" }}>{id}</div>
          <div style={{ flex: 1, color: "#aaa", fontSize: 13 }}>{isOccupied ? `${form.car} · ${form.orderNum}` : "Свободна"}</div>
          {isOccupied && <button onClick={() => onArchive(id)} style={{ background: "none", border: "1px solid #444", color: "#aaa", borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontSize: 12 }}>История</button>}
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#aaa", fontSize: 20, cursor: "pointer" }}>×</button>
        </div>
        <div style={{ padding: "1.5rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
            {[["car","Автомобиль","Toyota Camry 2020"],["plate","Гос. номер","А 123 ВС 77"],["orderNum","Заказ-наряд №","ЗН-2025-0847"],["master","Мастер-приёмщик","Петров И.В."]].map(([field, label, ph]) => (
              <div key={field}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#999", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
                <input value={form[field]} onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))} placeholder={ph} style={inputSt} />
              </div>
            ))}
          </div>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#999", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Примечания</div>
            <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} style={{ ...inputSt, resize: "vertical" }} />
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13, color: "#333", marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
              ПЕРЕЧЕНЬ ЗАПЧАСТЕЙ
              <button onClick={addPart} style={{ background: "#0f0f0f", color: "#fff", border: "none", borderRadius: 4, padding: "2px 10px", cursor: "pointer", fontSize: 12 }}>+ добавить</button>
            </div>
            {form.parts.map((p, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 140px 60px 32px", gap: 6, marginBottom: 6 }}>
                <input value={p.name} onChange={e => setPart(i, "name", e.target.value)} placeholder="Наименование" style={inputSt} />
                <input value={p.article} onChange={e => setPart(i, "article", e.target.value)} placeholder="Артикул" style={inputSt} />
                <input value={p.qty} onChange={e => setPart(i, "qty", e.target.value)} type="number" min="1" style={inputSt} />
                <button onClick={() => removePart(i)} style={{ background: "none", border: "1px solid #eee", borderRadius: 4, cursor: "pointer", color: "#999", fontSize: 16 }}>×</button>
              </div>
            ))}
          </div>
        </div>
        <div style={{ padding: "1rem 1.5rem", borderTop: "1px solid #eee", display: "flex", gap: 8, justifyContent: "flex-end" }}>
          {isOccupied && (
            <button onClick={() => { if (window.confirm("Освободить ячейку?")) onFree(id); }} style={{ background: "#fff3e0", border: "1px solid #ffcc02", color: "#e65100", borderRadius: 6, padding: "8px 18px", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Освободить ячейку</button>
          )}
          <button onClick={() => onSave(id, form)} style={{ background: "#0f0f0f", color: "#fff", border: "none", borderRadius: 6, padding: "8px 24px", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Сохранить</button>
        </div>
      </div>
    </div>
  );
}

function ArchiveModal({ cellId, cells, onFree, onClose }) {
  const data = cells[cellId];
  const archive = data?._archive || [];
  const isOccupied = data?.orderNum;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1010, padding: "1rem" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, width: "100%", maxWidth: 560, maxHeight: "80vh", overflow: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        <div style={{ padding: "1.25rem 1.5rem", borderBottom: "1px solid #eee", display: "flex", alignItems: "center", gap: "1rem" }}>
          <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 600, fontSize: 15 }}>{cellId}</div>
          <span style={{ color: "#666", fontSize: 13 }}>История движения</span>
          <div style={{ flex: 1 }} />
          {isOccupied && <button onClick={() => { if (window.confirm("Освободить ячейку?")) onFree(cellId); }} style={{ background: "#fff3e0", border: "1px solid #ffcc02", color: "#e65100", borderRadius: 6, padding: "5px 12px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Освободить</button>}
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#999" }}>×</button>
        </div>
        <div style={{ padding: "1.25rem 1.5rem" }}>
          {archive.length === 0 && <div style={{ color: "#999", fontSize: 14 }}>История пуста</div>}
          {archive.map((entry, i) => (
            <div key={i} style={{ border: "1px solid #eee", borderRadius: 8, padding: 14, marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{entry.car} · {entry.orderNum}</span>
                <span style={{ fontSize: 12, color: "#999" }}>{entry.openedAt} → {entry.freedAt}</span>
              </div>
              <div style={{ fontSize: 13, color: "#666" }}>Мастер: {entry.master || "—"} · {entry.parts?.length || 0} деталей</div>
              {entry.parts?.length > 0 && <div style={{ marginTop: 6, fontSize: 12, color: "#888" }}>{entry.parts.map(p => p.name).filter(Boolean).join(", ")}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ConfigModal({ config, setConfig, newZone, setNewZone, onClose }) {
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [editingId, setEditingId] = useState({});

  const addZone = () => {
    if (!newZone.label.trim()) return;
    const autoId = newZone.label.replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase() || ("Z" + (config.zones.length + 1));
    const id = (newZone.customId || "").trim().toUpperCase() || autoId;
    if (config.zones.find(z => z.id === id)) { setNewZone(n => ({ ...n, _err: "Индекс уже занят" })); return; }
    setConfig({ ...config, zones: [...config.zones, { id, label: newZone.label, rows: +newZone.rows, cols: +newZone.cols }] });
    setNewZone({ label: "", rows: 3, cols: 5, customId: "", _err: "" });
  };

  const removeZone = (id) => {
    setConfig({ ...config, zones: config.zones.filter(z => z.id !== id) });
    setConfirmDelete(null);
  };

  const updateZone = (id, field, val) => setConfig({ ...config, zones: config.zones.map(z => z.id === id ? { ...z, [field]: (field === "rows" || field === "cols") ? +val : val } : z) });

  const commitIdChange = (oldId) => {
    const newId = (editingId[oldId] || "").trim().toUpperCase();
    if (!newId || newId === oldId) { setEditingId(e => { const n = { ...e }; delete n[oldId]; return n; }); return; }
    if (config.zones.find(z => z.id === newId)) return;
    setConfig({ ...config, zones: config.zones.map(z => z.id === oldId ? { ...z, id: newId } : z) });
    setEditingId(e => { const n = { ...e }; delete n[oldId]; return n; });
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1020, padding: "1rem" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, width: "100%", maxWidth: 560, maxHeight: "85vh", overflow: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        <div style={{ padding: "1.25rem 1.5rem", borderBottom: "1px solid #eee", display: "flex", alignItems: "center" }}>
          <span style={{ fontWeight: 600 }}>Настройки склада</span>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#999" }}>×</button>
        </div>
        <div style={{ padding: "1.5rem" }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: "#666", marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>Зоны хранения</div>
          {config.zones.map(z => (
            <div key={z.id} style={{ border: "1px solid #eee", borderRadius: 8, padding: 12, marginBottom: 10 }}>
              <div style={{ display: "grid", gridTemplateColumns: "80px 1fr 72px 72px 36px", gap: 8, alignItems: "center" }}>
                <input
                  value={editingId[z.id] !== undefined ? editingId[z.id] : z.id}
                  onChange={e => setEditingId(ei => ({ ...ei, [z.id]: e.target.value.toUpperCase().slice(0, 6) }))}
                  onBlur={() => commitIdChange(z.id)}
                  onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }}
                  style={{ ...inputSt, fontFamily: "'IBM Plex Mono',monospace", fontWeight: 700, textAlign: "center", background: "#0f0f0f", color: "#fff", borderColor: "#0f0f0f", letterSpacing: 1, padding: "7px 4px" }}
                />
                <input value={z.label} onChange={e => updateZone(z.id, "label", e.target.value)} style={inputSt} />
                <input type="number" min="1" max="20" value={z.rows} onChange={e => updateZone(z.id, "rows", e.target.value)} style={{ ...inputSt, textAlign: "center" }} title="Рядов" />
                <input type="number" min="1" max="20" value={z.cols} onChange={e => updateZone(z.id, "cols", e.target.value)} style={{ ...inputSt, textAlign: "center" }} title="Столбцов" />
                <button onClick={() => setConfirmDelete(confirmDelete === z.id ? null : z.id)} style={{ background: confirmDelete === z.id ? "#ffeaea" : "none", border: "1px solid #fcc", borderRadius: 4, cursor: "pointer", color: "#e57373", fontSize: 18, padding: "2px 6px", lineHeight: 1 }}>×</button>
              </div>
              <div style={{ fontSize: 11, color: "#bbb", marginTop: 5 }}>Рядов: {z.rows} · Столбцов: {z.cols} · Ячеек: {z.rows * z.cols}</div>
              {confirmDelete === z.id && (
                <div style={{ marginTop: 10, background: "#fff3f3", border: "1px solid #fcc", borderRadius: 6, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 13, color: "#c62828", flex: 1 }}>Удалить зону <b>{z.id}</b>?</span>
                  <button onClick={() => removeZone(z.id)} style={{ background: "#c62828", color: "#fff", border: "none", borderRadius: 5, padding: "5px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Удалить</button>
                  <button onClick={() => setConfirmDelete(null)} style={{ background: "none", border: "1px solid #ddd", borderRadius: 5, padding: "5px 10px", cursor: "pointer", fontSize: 13 }}>Отмена</button>
                </div>
              )}
            </div>
          ))}
          <div style={{ border: "1px dashed #ddd", borderRadius: 8, padding: 12, marginTop: 10 }}>
            <div style={{ fontSize: 12, color: "#999", marginBottom: 8 }}>Добавить зону</div>
            <div style={{ display: "grid", gridTemplateColumns: "80px 1fr 72px 72px auto", gap: 8 }}>
              <input value={newZone.customId || ""} onChange={e => setNewZone(n => ({ ...n, customId: e.target.value.toUpperCase().slice(0, 6), _err: "" }))} placeholder="B" maxLength={6} style={{ ...inputSt, fontFamily: "'IBM Plex Mono',monospace", textAlign: "center", fontWeight: 600 }} title="Индекс" />
              <input value={newZone.label} onChange={e => setNewZone(n => ({ ...n, label: e.target.value, _err: "" }))} placeholder="Название зоны" style={{ ...inputSt, borderColor: newZone._err ? "#e57373" : undefined }} onKeyDown={e => { if (e.key === "Enter") addZone(); }} />
              <input type="number" min="1" max="20" value={newZone.rows} onChange={e => setNewZone(n => ({ ...n, rows: e.target.value }))} style={{ ...inputSt, textAlign: "center" }} title="Рядов" />
              <input type="number" min="1" max="20" value={newZone.cols} onChange={e => setNewZone(n => ({ ...n, cols: e.target.value }))} style={{ ...inputSt, textAlign: "center" }} title="Столбцов" />
              <button onClick={addZone} style={{ background: "#0f0f0f", color: "#fff", border: "none", borderRadius: 6, padding: "7px 16px", cursor: "pointer", fontSize: 13 }}>+</button>
            </div>
            {newZone._err && <div style={{ fontSize: 12, color: "#e57373", marginTop: 6 }}>{newZone._err}</div>}
          </div>

          <div style={{ marginTop: "1.5rem", borderTop: "1px solid #eee", paddingTop: "1.5rem" }}>
            <div style={{ fontWeight: 600, fontSize: 13, color: "#666", marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>Зависшие ячейки</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 13, color: "#666" }}>Считать ячейку зависшей через</span>
              <input type="number" min="1" max="90" value={config.staleDays || 7} onChange={e => setConfig({ ...config, staleDays: +e.target.value || 1 })} style={{ ...inputSt, width: 64, textAlign: "center" }} />
              <span style={{ fontSize: 13, color: "#666" }}>дн.</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const LABEL_SIZES = [
  { id: "xs",   label: "XS — 40×20 мм",  w: 40, h: 20, cols: 5, numPt: 14, qr: false },
  { id: "s",    label: "S — 52×30 мм",   w: 52, h: 30, cols: 4, numPt: 18, qr: false },
  { id: "m",    label: "M — 70×40 мм",   w: 70, h: 40, cols: 3, numPt: 22, qr: true },
  { id: "l",    label: "L — 90×50 мм",   w: 90, h: 50, cols: 2, numPt: 28, qr: true },
  { id: "xl",   label: "XL — 105×74 мм", w: 105, h: 74, cols: 2, numPt: 34, qr: true },
  { id: "a4",   label: "A4 — 1 этикетка на лист", w: 190, h: 267, cols: 1, numPt: 64, qr: true },
];

function LabelPrintModal({ zone, onClose }) {
  const [sizeId, setSizeId] = useState("s");
  const [printing, setPrinting] = useState(false);
  const cells = Array.from({ length: zone.rows }, (_, r) =>
    Array.from({ length: zone.cols }, (_, c) => cellId(zone.id, r, c))
  ).flat();

  const doPrint = async () => {
    const sz = LABEL_SIZES.find(s => s.id === sizeId);
    setPrinting(true);
    let qrMap = {};
    if (sz.qr) {
      // quiet-zone margin baked into the PNG so the code stays scannable when shrunk
      for (const id of cells) {
        const url = `${window.location.origin}${window.location.pathname}?cell=${id}`;
        qrMap[id] = await QRCode.toDataURL(url, { margin: 1, width: 300 });
      }
    }
    setPrinting(false);

    const isA4 = sz.id === "a4";
    const pad = Math.max(2, Math.round(sz.h * 0.07));
    const qrPad = Math.max(1, Math.round(pad * 0.4));
    const qrSizeMm = isA4
      ? Math.round(sz.w * 0.58)
      : Math.round(Math.min(sz.w * 0.36, sz.h - pad * 2) - qrPad * 2);
    const layout = isA4 ? "column" : "row";
    const accentSize = Math.max(6, Math.round(Math.min(sz.w, sz.h) * 0.2));
    const logoSize = Math.round(accentSize * 0.74 * 10) / 10;
    const logoUrl = `${window.location.origin}/logo-mark.png`;

    const labelInner = (id) => {
      const qrImg = qrMap[id]
        ? `<div class="qrbox"><img class="qr" src="${qrMap[id]}" width="${qrSizeMm}mm" height="${qrSizeMm}mm" /></div>`
        : "";
      const textBlock = `<div class="text"><div class="zone">${zone.label}</div><div class="top">Ячейка</div><div class="num">${id}</div></div>`;
      const divider = qrMap[id] ? `<div class="divider"></div>` : "";
      const inner = isA4 ? `${textBlock}${divider}${qrImg}` : `${qrImg}${divider}${textBlock}`;
      const accent = `<div class="accent"><img class="logo" src="${logoUrl}" width="${logoSize}mm" height="${logoSize}mm" /></div>`;
      return `${accent}<div class="content">${inner}</div>`;
    };

    const w = window.open("", "_blank");
    const pageBreak = isA4 ? "page-break-after:always;" : "";
    w.document.write(`<html><head><title>Этикетки ${zone.label}</title><style>
      *{box-sizing:border-box}
      body{margin:0;font-family:'IBM Plex Sans','Helvetica Neue',sans-serif}
      .grid{display:grid;grid-template-columns:repeat(${sz.cols},${sz.w}mm)}
      .label{border:1.5px solid #1a1a1a;width:${sz.w}mm;height:${sz.h}mm;display:flex;flex-direction:${layout};${pageBreak};overflow:hidden}
      .accent{flex-shrink:0;background:#fff;display:flex;align-items:center;justify-content:center;${isA4 ? `width:100%;height:${accentSize}mm;border-bottom:1.5px solid #1a1a1a` : `width:${accentSize}mm;height:100%;border-right:1.5px solid #1a1a1a`}}
      .logo{object-fit:contain}
      .content{flex:1;min-width:0;min-height:0;display:flex;flex-direction:${layout};align-items:center;justify-content:center;gap:${pad * 0.7}mm;padding:${pad}mm}
      .qrbox{background:#fff;border:1px solid #ddd;padding:${qrPad}mm;display:flex;flex-shrink:0;line-height:0}
      .divider{${isA4 ? `width:60%;height:1px;margin:${pad * 0.3}mm 0` : `width:1px;align-self:stretch;margin:${pad * 0.3}mm 0`};background:#e3e3e3}
      .text{display:flex;flex-direction:column;align-items:${isA4 ? "center" : "flex-start"};min-width:0}
      .zone{font-size:${Math.round(sz.numPt * 0.32)}pt;color:#aaa;letter-spacing:0.5px;margin-bottom:${Math.max(1, Math.round(sz.numPt * 0.08))}px;font-weight:500}
      .top{font-size:${Math.round(sz.numPt * 0.36)}pt;color:#1a1a1a;letter-spacing:1.5px;text-transform:uppercase;font-weight:600;margin-bottom:${Math.max(2, Math.round(sz.numPt * 0.16))}px;opacity:0.55}
      .num{font-family:'IBM Plex Mono',monospace;font-size:${sz.numPt}pt;font-weight:700;letter-spacing:0.5px;line-height:1;color:#1a1a1a}
      @media print{@page{size:A4;margin:8mm}}
    </style>
    <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@700&display=swap" rel="stylesheet" />
    </head><body><div class="grid">
    ${cells.map(id => `<div class="label">${labelInner(id)}</div>`).join("")}
    </div><script>window.print();<\/script></body></html>`);
    w.document.close();
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1030 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, padding: "2rem", maxWidth: 420, width: "90%", textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>🖨</div>
        <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 8 }}>Печать этикеток</div>
        <div style={{ color: "#666", fontSize: 14, marginBottom: "1.5rem" }}>{zone.label} · {zone.rows * zone.cols} этикеток</div>
        <div style={{ textAlign: "left", marginBottom: "1.25rem" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#999", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Размер этикетки</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {LABEL_SIZES.map(sz => (
              <label key={sz.id} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", padding: "8px 12px", borderRadius: 8, border: `1px solid ${sizeId === sz.id ? "#0f0f0f" : "#e0e0e0"}`, background: sizeId === sz.id ? "#f5f5f5" : "#fff" }}>
                <input type="radio" name="labelSize" value={sz.id} checked={sizeId === sz.id} onChange={() => setSizeId(sz.id)} style={{ accentColor: "#0f0f0f" }} />
                <span style={{ fontSize: 14, flex: 1 }}>{sz.label}</span>
                {sz.qr && <span style={{ fontSize: 11, color: "#999" }}>+ QR</span>}
              </label>
            ))}
          </div>
        </div>
        <button onClick={doPrint} disabled={printing} style={{ background: "#0f0f0f", color: "#fff", border: "none", borderRadius: 8, padding: "10px 32px", cursor: printing ? "default" : "pointer", fontSize: 14, fontWeight: 600, marginRight: 8, opacity: printing ? 0.6 : 1 }}>{printing ? "Готовлю..." : "Печатать"}</button>
        <button onClick={onClose} style={{ background: "none", border: "1px solid #ddd", borderRadius: 8, padding: "10px 20px", cursor: "pointer", fontSize: 14 }}>Отмена</button>
      </div>
    </div>
  );
}

function PrintSheet({ cell, cells, onClose }) {
  const { id } = cell;
  const data = cells[id] || {};
  const today = new Date().toLocaleDateString("ru-RU");

  const doPrint = () => {
    const w = window.open("", "_blank");
    const parts = data.parts || [];
    const rows = Math.max(8, parts.length + 2);
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Лист ячейки ${id}</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:'Helvetica Neue',Arial,sans-serif;font-size:10pt;color:#1a1a1a;padding:15mm;background:#fff}
      .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;border-bottom:2px solid #1a1a1a;padding-bottom:10px}
      .title{font-size:18pt;font-weight:700;letter-spacing:1px;text-transform:uppercase}
      .subtitle{font-size:9pt;color:#666;margin-top:3px}
      .badge{background:#1a1a1a;color:#fff;font-size:18pt;font-weight:700;padding:8px 16px;border-radius:4px;font-family:'Courier New',monospace;letter-spacing:2px}
      .meta-row{display:flex;gap:0;margin-bottom:14px}
      .meta-box{border:1px solid #ddd;padding:10px 14px;flex:1}
      .meta-box:first-child{border-right:none}
      .meta-label{font-size:7pt;color:#999;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px}
      .meta-val{font-size:12pt;font-weight:600}
      .section{margin-bottom:14px}
      .section-title{background:#1a1a1a;color:#fff;padding:5px 10px;font-size:8pt;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:0}
      table{width:100%;border-collapse:collapse;font-size:9pt}
      th{background:#1a1a1a;color:#fff;padding:5px 8px;text-align:left;font-size:8pt}
      td{border:1px solid #ddd;padding:6px 8px;vertical-align:middle}
      tr:nth-child(even) td{background:#fafafa}
      .check{width:20px;height:20px;border:1.5px solid #999;display:inline-block;border-radius:2px}
      .notes-box{border:1px solid #ddd;min-height:55px;padding:8px;font-size:9pt}
      .footer{margin-top:20px;border-top:1px solid #ddd;padding-top:8px;display:flex;justify-content:space-between;font-size:8pt;color:#999}
      @media print{@page{size:A4 portrait;margin:12mm}body{padding:0}}
    </style></head><body>
    <div class="header">
      <div>
        <div class="title">Лист ячейки склада запчастей</div>
        <div class="subtitle">Заказ-наряд № ${data.orderNum || "—"} · ${data.car || "—"} ${data.plate ? "· " + data.plate : ""}</div>
      </div>
      <div class="badge">${id}</div>
    </div>
    <div class="meta-row">
      <div class="meta-box"><div class="meta-label">Дата открытия</div><div class="meta-val">${data.openedAt || today}</div></div>
      <div class="meta-box"><div class="meta-label">Мастер-приёмщик</div><div class="meta-val">${data.master || "—"}</div></div>
    </div>
    <div class="section">
      <div class="section-title">Перечень запчастей</div>
      <table><thead><tr><th style="width:30px">№</th><th>Наименование запчасти</th><th style="width:130px">Артикул / OEM</th><th style="width:50px">Кол.</th><th style="width:30px">✓</th><th style="width:110px">Дата приёмки</th><th>Состояние / Дефекты &amp; подпись</th></tr></thead>
      <tbody>${Array.from({ length: rows }, (_, i) => { const p = parts[i] || {}; return `<tr><td style="text-align:center;color:#bbb">${i+1}</td><td>${p.name||""}</td><td>${p.article||""}</td><td style="text-align:center">${p.qty||""}</td><td><span class="check"></span></td><td></td><td></td></tr>`; }).join("")}</tbody></table>
    </div>
    <div class="section">
      <div class="section-title">Примечания / Особые условия хранения</div>
      <div class="notes-box">${data.notes || ""}</div>
    </div>
    <div class="section">
      <div class="section-title">История движения по ячейке</div>
      <table><thead><tr><th style="width:110px">Дата / Время</th><th style="width:170px">Событие</th><th style="width:150px">Сотрудник (ФИО)</th><th style="width:100px">Подпись</th><th>Комментарий</th></tr></thead>
      <tbody>${Array.from({length:7},()=>"<tr><td></td><td></td><td></td><td></td><td></td></tr>").join("")}</tbody></table>
    </div>
    <div class="footer">
      <span>Лист ячейки ${id} · ${data.car||"—"} (${data.plate||"—"}) · ${data.orderNum||"—"}</span>
      <span>Форма СК-01 · rev 1.2</span>
    </div>
    <script>window.print();<\/script></body></html>`);
    w.document.close();
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1040 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, padding: "2rem", maxWidth: 400, width: "90%", textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>📄</div>
        <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 4 }}>Лист ячейки {id}</div>
        {data.orderNum ? <div style={{ color: "#666", fontSize: 13, marginBottom: "1.5rem" }}>{data.car} · {data.orderNum}</div>
          : <div style={{ color: "#999", fontSize: 13, marginBottom: "1.5rem" }}>Ячейка свободна — пустой лист</div>}
        <button onClick={doPrint} style={{ background: "#0f0f0f", color: "#fff", border: "none", borderRadius: 8, padding: "10px 32px", cursor: "pointer", fontSize: 14, fontWeight: 600, marginRight: 8 }}>Печатать</button>
        <button onClick={onClose} style={{ background: "none", border: "1px solid #ddd", borderRadius: 8, padding: "10px 20px", cursor: "pointer", fontSize: 14 }}>Отмена</button>
      </div>
    </div>
  );
}