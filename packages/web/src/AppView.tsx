import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppBundle, AppDetail, Field, FieldValue, RecordEnvelope, RecordPage } from "@agentos/contracts";
import { ApiError, NetworkError, api, describeError, newKey } from "./api";

const PAGE = 20;

type Draft = Record<string, FieldValue>;

function defaultDraft(bundle: AppBundle): Draft {
  const d: Draft = {};
  for (const k of bundle.view.formFields) {
    const f = bundle.data.fields[k]!;
    if (f.default !== undefined) d[k] = f.default;
    else if (f.type === "boolean") d[k] = false;
    else if (f.type === "string") d[k] = "";
    else if (f.type === "enum") d[k] = f.values[0]!;
  }
  return d;
}

function display(f: Field, v: FieldValue | undefined): string {
  if (v === undefined) return "";
  if (f.type === "boolean") return v ? "✓" : "—";
  return String(v);
}

function FieldInput(props: { name: string; field: Field; value: FieldValue | undefined; onChange: (v: FieldValue | undefined) => void; error?: string; disabled?: boolean }) {
  const { field: f, value, onChange, name } = props;
  const id = `f-${name}`;
  let input;
  if (f.type === "boolean") {
    input = <input id={id} type="checkbox" checked={value === true} disabled={props.disabled} onChange={(e) => onChange(e.target.checked)} />;
  } else if (f.type === "enum") {
    input = (
      <select id={id} value={String(value ?? "")} disabled={props.disabled} onChange={(e) => onChange(e.target.value)}>
        {f.values.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  } else if (f.type === "integer") {
    input = (
      <input
        id={id}
        type="number"
        step={1}
        min={f.minimum}
        max={f.maximum}
        disabled={props.disabled}
        value={value === undefined ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      />
    );
  } else if (f.maxLength > 200) {
    input = <textarea id={id} rows={3} maxLength={f.maxLength} disabled={props.disabled} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
  } else {
    input = <input id={id} type="text" maxLength={f.maxLength} disabled={props.disabled} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <label className={`field field-${f.type}`} htmlFor={id}>
      <span className="field-label">{f.label}</span>
      {input}
      {props.error && <span className="field-error">{props.error}</span>}
    </label>
  );
}

interface FormState {
  mode: "create" | "edit";
  record?: RecordEnvelope;
  draft: Draft;
  epoch: number;
  key: string;
  errors: Record<string, string>;
  message?: string;
  busy: boolean;
}

export function AppView(props: { detail: AppDetail; onChanged: () => void; refreshToken: number }) {
  const { detail } = props;
  const bundle = detail.bundle! as AppBundle;
  const fields = bundle.data.fields;
  const writable = bundle.manifest.capabilities.includes("records.write");
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Record<string, FieldValue>>({});
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<RecordPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ rec: RecordEnvelope; key: string } | null>(null);

  // Drop filters that the active version no longer offers.
  useEffect(() => {
    setFilters((f) => Object.fromEntries(Object.entries(f).filter(([k]) => bundle.view.filters.includes(k))));
    setOffset(0);
  }, [detail.activeRevisionId, bundle.view.filters]);

  const load = useCallback(async () => {
    try {
      const p = await api.records(detail.appId, { q: bundle.view.searchField ? q : undefined, filters, offset, limit: PAGE });
      setPage(p);
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, [detail.appId, q, filters, offset, bundle.view.searchField]);

  useEffect(() => {
    void load();
  }, [load, props.refreshToken, detail.appEpoch]);

  const stale = form !== null && form.epoch !== detail.appEpoch;

  const openCreate = () => setForm({ mode: "create", draft: defaultDraft(bundle), epoch: detail.appEpoch, key: newKey(), errors: {}, busy: false });
  const openEdit = (rec: RecordEnvelope) => {
    const draft: Draft = {};
    for (const k of bundle.view.formFields) if (rec.data[k] !== undefined) draft[k] = rec.data[k]!;
    setForm({ mode: "edit", record: rec, draft, epoch: detail.appEpoch, key: newKey(), errors: {}, busy: false });
  };

  /** Rebase a dirty form onto the new version: keep values for fields the new form still has. */
  const rebase = () => {
    if (!form) return;
    const fresh = form.mode === "create" ? defaultDraft(bundle) : {};
    for (const k of bundle.view.formFields) if (form.draft[k] !== undefined) fresh[k] = form.draft[k]!;
    if (form.mode === "edit") {
      const cur = page?.items.find((r) => r.id === form.record!.id);
      setForm({ ...form, draft: fresh, epoch: detail.appEpoch, key: newKey(), record: cur ?? form.record, errors: {}, message: undefined });
    } else setForm({ ...form, draft: fresh, epoch: detail.appEpoch, key: newKey(), errors: {}, message: undefined });
  };

  const submit = async () => {
    if (!form || stale) return;
    setForm({ ...form, busy: true, message: undefined, errors: {} });
    try {
      if (form.mode === "create") {
        const data: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(form.draft)) if (v !== undefined) data[k] = v;
        await api.createRecord(detail.appId, { expectedAppEpoch: form.epoch, data }, form.key);
      } else {
        const changes: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(form.draft)) if (v !== undefined && v !== form.record!.data[k]) changes[k] = v;
        if (Object.keys(changes).length === 0) {
          setForm(null);
          return;
        }
        await api.updateRecord(detail.appId, form.record!.id, { expectedAppEpoch: form.epoch, expectedRecordVersion: form.record!.recordVersion, changes }, form.key);
      }
      setForm(null);
      setOffset(0);
      await load();
      props.onChanged();
    } catch (e) {
      const errs: Record<string, string> = {};
      if (e instanceof ApiError && e.code === "INVALID_RECORD") {
        for (const i of (e.body.details?.issues as { path: string; message: string }[] | undefined) ?? []) errs[i.path.split("/").pop()!] = i.message;
      }
      // Network failure keeps the key so a retry cannot write twice; a server answer needs a fresh key.
      const keepKey = e instanceof NetworkError;
      setForm({ ...form, busy: false, errors: errs, message: describeError(e), key: keepKey ? form.key : newKey() });
      if (e instanceof ApiError && (e.code === "RECORD_VERSION_STALE" || e.code === "APP_EPOCH_STALE")) {
        props.onChanged();
        void load();
      }
    }
  };

  const doDelete = async () => {
    if (!pendingDelete) return;
    try {
      await api.deleteRecord(detail.appId, pendingDelete.rec.id, { expectedAppEpoch: detail.appEpoch, expectedRecordVersion: pendingDelete.rec.recordVersion }, pendingDelete.key);
      setPendingDelete(null);
      await load();
    } catch (e) {
      setError(describeError(e));
      if (!(e instanceof NetworkError)) setPendingDelete(null);
    }
  };

  const filterFields = useMemo(() => bundle.view.filters.map((k) => [k, fields[k]!] as const), [bundle, fields]);
  const total = page?.total ?? 0;

  return (
    <section className="app-view" aria-label={bundle.manifest.title}>
      <header className="app-header">
        <div>
          <h2>{bundle.manifest.title}</h2>
          {bundle.manifest.description && <p className="muted">{bundle.manifest.description}</p>}
        </div>
        {writable && (
          <button className="primary" onClick={openCreate} disabled={form !== null}>
            新建
          </button>
        )}
      </header>

      <div className="toolbar">
        {bundle.view.searchField && (
          <input
            className="search"
            type="search"
            placeholder={`搜索${fields[bundle.view.searchField]!.label}`}
            maxLength={128}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOffset(0);
            }}
          />
        )}
        {filterFields.map(([k, f]) => (
          <label key={k} className="filter">
            <span>{f.label}</span>
            <select
              aria-label={`筛选${f.label}`}
              value={filters[k] === undefined ? "" : String(filters[k])}
              onChange={(e) => {
                const v = e.target.value;
                setOffset(0);
                setFilters((cur) => {
                  const next = { ...cur };
                  if (v === "") delete next[k];
                  else next[k] = f.type === "boolean" ? v === "true" : v;
                  return next;
                });
              }}
            >
              <option value="">全部</option>
              {f.type === "boolean" ? (
                <>
                  <option value="true">是</option>
                  <option value="false">否</option>
                </>
              ) : f.type === "enum" ? (
                f.values.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))
              ) : null}
            </select>
          </label>
        ))}
      </div>

      {form && (
        <div className="record-form" role="dialog" aria-label={form.mode === "create" ? "新建记录" : "编辑记录"}>
          <h3>{form.mode === "create" ? "新建记录" : "编辑记录"}</h3>
          {stale && (
            <div className="banner warn">
              应用版本已切换，表单已停用。你的输入已保留。
              <button onClick={rebase}>刷新表单</button>
            </div>
          )}
          {bundle.view.formFields.map((k) => (
            <FieldInput
              key={k}
              name={k}
              field={fields[k]!}
              value={form.draft[k]}
              error={form.errors[k]}
              disabled={stale || form.busy}
              onChange={(v) => setForm((cur) => (cur ? { ...cur, draft: { ...cur.draft, [k]: v as FieldValue } } : cur))}
            />
          ))}
          {form.message && <div className="banner error">{form.message}</div>}
          <div className="actions">
            <button className="primary" onClick={() => void submit()} disabled={stale || form.busy}>
              {form.message && !stale ? "重试" : "保存"}
            </button>
            <button onClick={() => setForm(null)}>取消</button>
          </div>
        </div>
      )}

      {error && <div className="banner error">{error}</div>}

      <table className="records">
        <thead>
          <tr>
            {bundle.view.columns.map((k) => (
              <th key={k}>{fields[k]!.label}</th>
            ))}
            {writable && <th className="row-actions">操作</th>}
          </tr>
        </thead>
        <tbody>
          {page?.items.map((r) => (
            <tr key={r.id}>
              {bundle.view.columns.map((k) => (
                <td key={k} className={`col-${fields[k]!.type}`}>
                  {display(fields[k]!, r.data[k])}
                </td>
              ))}
              {writable && (
                <td className="row-actions">
                  <button onClick={() => openEdit(r)} disabled={form !== null}>
                    编辑
                  </button>
                  <button className="danger" onClick={() => setPendingDelete({ rec: r, key: newKey() })}>
                    删除
                  </button>
                </td>
              )}
            </tr>
          ))}
          {page && page.items.length === 0 && (
            <tr>
              <td colSpan={bundle.view.columns.length + (writable ? 1 : 0)} className="empty">
                没有记录
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="pager">
        <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
          上一页
        </button>
        <span>
          {total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE, total)} / 共 {total} 条
        </span>
        <button disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
          下一页
        </button>
      </div>

      {pendingDelete && (
        <div className="banner warn" role="alertdialog">
          删除“{display(fields[bundle.view.titleField]!, pendingDelete.rec.data[bundle.view.titleField])}”？删除是永久的，切换应用版本不会恢复它（只能从备份恢复）。
          <button className="danger" onClick={() => void doDelete()}>
            确认删除
          </button>
          <button onClick={() => setPendingDelete(null)}>取消</button>
        </div>
      )}
    </section>
  );
}
