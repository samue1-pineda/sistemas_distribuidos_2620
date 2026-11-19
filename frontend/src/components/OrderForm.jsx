import { useEffect, useMemo, useState } from "react";
import { formatMoney, shortId } from "../format.js";

const emptyItem = () => ({ product: "", quantity: 1, unit_price: "" });

function fromOrder(order) {
  return {
    customer_name: order.customer_name,
    items: order.items.map((item) => ({ ...item })),
  };
}

function validate(form) {
  if (form.customer_name.trim().length < 2) return "El nombre del cliente debe tener al menos 2 caracteres.";
  if (form.items.length === 0) return "Agrega al menos un ítem.";
  for (const [index, item] of form.items.entries()) {
    if (!item.product.trim()) return `Ítem ${index + 1}: indica el producto.`;
    if (!Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1) return `Ítem ${index + 1}: la cantidad debe ser un entero ≥ 1.`;
    if (item.unit_price === "" || Number(item.unit_price) < 0) return `Ítem ${index + 1}: el precio debe ser ≥ 0.`;
  }
  return null;
}

export default function OrderForm({ editing, busy, onCreate, onUpdate, onCancelEdit, defaultCustomer = "", embedded = false }) {
  const blank = () => ({ customer_name: defaultCustomer, items: [emptyItem()] });
  const [form, setForm] = useState(blank);
  const [error, setError] = useState(null);

  useEffect(() => {
    setForm(editing ? fromOrder(editing) : blank());
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const total = useMemo(
    () => form.items.reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.unit_price) || 0), 0),
    [form.items],
  );

  const setItem = (index, field, value) =>
    setForm((f) => ({ ...f, items: f.items.map((item, i) => (i === index ? { ...item, [field]: value } : item)) }));

  const submit = async (event) => {
    event.preventDefault();
    const problem = validate(form);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    const payload = {
      customer_name: form.customer_name.trim(),
      items: form.items.map((item) => ({
        product: item.product.trim(),
        quantity: Number(item.quantity),
        unit_price: Number(item.unit_price),
      })),
    };
    try {
      if (editing) await onUpdate(editing.id, payload);
      else {
        await onCreate(payload);
        setForm(blank());
      }
    } catch {
      /* el error ya se notificó */
    }
  };

  return (
    <form className={`order-form ${embedded ? "order-form--embedded" : "card"}`} onSubmit={submit} noValidate>
      {!embedded && (
        <header className="card-head">
          <h3>{editing ? `Editar pedido #${shortId(editing.id)}` : "Datos del pedido"}</h3>
          {editing && (
            <button type="button" className="btn btn-link" onClick={onCancelEdit}>
              Cancelar
            </button>
          )}
        </header>
      )}

      <label className="field">
        <span>Cliente</span>
        <input
          value={form.customer_name}
          onChange={(e) => setForm((f) => ({ ...f, customer_name: e.target.value }))}
          placeholder="Nombre del cliente"
          maxLength={120}
          autoComplete="off"
        />
      </label>

      <div className="items-head">
        <span>Producto</span>
        <span>Cant.</span>
        <span>Precio unit.</span>
        <span />
      </div>
      {form.items.map((item, index) => (
        <div className="item-row" key={index}>
          <input
            aria-label={`Producto ${index + 1}`}
            value={item.product}
            onChange={(e) => setItem(index, "product", e.target.value)}
            placeholder="Ej. Caja 40x40"
            maxLength={120}
          />
          <input
            aria-label={`Cantidad ${index + 1}`}
            type="number"
            min="1"
            step="1"
            value={item.quantity}
            onChange={(e) => setItem(index, "quantity", e.target.value)}
          />
          <input
            aria-label={`Precio ${index + 1}`}
            type="number"
            min="0"
            step="0.01"
            value={item.unit_price}
            onChange={(e) => setItem(index, "unit_price", e.target.value)}
            placeholder="0.00"
          />
          <button
            type="button"
            className="icon-btn"
            title="Quitar ítem"
            aria-label={`Quitar ítem ${index + 1}`}
            disabled={form.items.length === 1}
            onClick={() => setForm((f) => ({ ...f, items: f.items.filter((_, i) => i !== index) }))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-link add-item"
        onClick={() => setForm((f) => ({ ...f, items: [...f.items, emptyItem()] }))}
        disabled={form.items.length >= 50}
      >
        + Agregar ítem
      </button>

      <div className="form-total">
        <span>Total estimado</span>
        <strong>{formatMoney(total)}</strong>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? "Guardando…" : editing ? "Guardar cambios" : "Crear pedido"}
      </button>
      <p className="hint muted">
        {editing
          ? "Sólo los pedidos en estado pendiente se pueden editar."
          : "El total lo recalcula el servidor. Cada pedido lleva un UUID para que los reintentos sean idempotentes."}
      </p>
    </form>
  );
}
