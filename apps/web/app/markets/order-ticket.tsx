"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  buildOrderSigningMessageV1,
  isLunarveilApiError,
  type EpochV1,
  type LunarveilApiClientV1,
  type MarketV1,
  type OrderSubmissionV1,
} from "@lunarveil/api-client";
import { WalletSignatureError, signSessionMessageV1 } from "@lunarveil/midnight";
import type { ConnectedAPI } from "@midnight-ntwrk/dapp-connector-api";

import { validateOrderDraftV1, type OrderDraftV1 } from "./orderDraft";

const PROBLEM_TEXT: Readonly<Record<string, string>> = {
  QUANTITY_REQUIRED: "Enter a quantity.",
  QUANTITY_NOT_INTEGER: "Quantity must be a whole number of atomic units.",
  QUANTITY_NOT_LOT_MULTIPLE: "Quantity must be a multiple of the market lot size.",
  PRICE_REQUIRED: "Enter a limit price.",
  PRICE_NOT_INTEGER: "Price must be a whole number of atomic units.",
  PRICE_NOT_TICK_MULTIPLE: "Price must be a multiple of the market tick size.",
  MIN_FILL_NOT_INTEGER: "Minimum fill must be a whole number.",
  MIN_FILL_ABOVE_QUANTITY: "Minimum fill cannot exceed the quantity.",
  M3_MIN_FILL_UNSUPPORTED: "Minimum fills are not supported by the current proof circuit.",
  M3_TIF_UNSUPPORTED: "Only good-for-epoch orders are supported by the current proof circuit.",
  M3_PARTIAL_FILL_REQUIRED: "The current proof circuit requires partial fills.",
  M3_UINT64_BOUND: "Quantity and price must fit the current proof circuit's Uint64 bound.",
  MARKET_NOT_ACCEPTING_ORDERS: "This market is not accepting orders.",
  EPOCH_NOT_OPEN: "This market has no open epoch.",
  EPOCH_FULL: "This epoch is full.",
  EPOCH_CLOSING: "This epoch is closing. The next one opens in a moment.",
};

const EMPTY_DRAFT: OrderDraftV1 = {
  side: "BUY",
  quantityLots: "",
  limitPriceTicks: "",
  minFillLots: "",
  tif: "GFE",
  allowPartial: true,
};

function failureCode(error: unknown): string {
  if (error instanceof WalletSignatureError) return error.code;
  if (isLunarveilApiError(error)) {
    return error.serverCode === undefined ? error.code : `${error.code} · ${error.serverCode}`;
  }
  return "UNEXPECTED_FAILURE";
}

/**
 * The private limit-order ticket.
 *
 * The order is encrypted in this browser before it is sent: the request body
 * carries ciphertext plus public metadata only. The commitment is computed
 * with the compiler-matching implementation from `@lunarveil/crypto`.
 *
 * The V1 trust boundary is stated on the form itself. The matcher decrypts
 * orders to match them; this UI must never imply end-to-end confidentiality
 * from the matcher.
 */
export function OrderTicket({
  api,
  market,
  epoch,
  session,
  wallet,
  nowMs,
  demoMode = false,
  onSubmitted,
}: {
  api: LunarveilApiClientV1 | undefined;
  market: MarketV1;
  epoch: EpochV1 | undefined;
  session: { readonly token: string; readonly traderTagHash?: string } | undefined;
  wallet: { readonly connected: ConnectedAPI; readonly verifyingKey: string } | undefined;
  nowMs: bigint;
  demoMode?: boolean;
  onSubmitted?: () => void;
}) {
  const [draft, setDraft] = useState<OrderDraftV1>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [accepted, setAccepted] = useState<OrderSubmissionV1 | undefined>(undefined);
  const [slowWallet, setSlowWallet] = useState(false);

  // Lace does not always open its signing window by itself.
  useEffect(() => {
    if (!busy) {
      setSlowWallet(false);
      return;
    }
    const timer = setTimeout(() => { setSlowWallet(true); }, 3_000);
    return () => { clearTimeout(timer); };
  }, [busy]);

  const problems = useMemo(
    () => validateOrderDraftV1(draft, market, epoch, nowMs),
    [draft, epoch, market, nowMs],
  );
  const ready = problems.length === 0 && session !== undefined && wallet !== undefined && api !== undefined;

  const submit = useCallback(async () => {
    if (!ready || epoch === undefined || session?.traderTagHash === undefined
      || wallet === undefined || api === undefined) {
      setFailure("NOT_READY");
      return;
    }
    setBusy(true);
    setFailure(undefined);
    setAccepted(undefined);
    try {
      const matcherKey = await api.getMatcherKey();
      // Loaded here, not at module scope: sealing pulls in the Compact
      // runtime's WebAssembly, which cannot be instantiated during
      // server-side rendering of this route. See ADR-0040.
      const { buildSealedOrderV1 } = await import("./sealOrder");
      const sealed = await buildSealedOrderV1({
        draft,
        market,
        epoch,
        matcherKey,
        traderTagHash: session.traderTagHash,
        clientRequestId: crypto.randomUUID(),
        nowMs,
        lifetimeMs: 3_600_000n,
      });

      // The wallet signs the public envelope, ciphertext included, so an
      // interceptor cannot swap the payload behind a valid signature.
      const message = buildOrderSigningMessageV1(sealed.envelope);
      const signed = await signSessionMessageV1(wallet.connected, message);

      const result = await api.submitOrder({
        bearerToken: session.token,
        envelope: sealed.envelope,
        clientSignature: base64Url(hexToBytes(signed.signature)),
        verifyingKey: signed.verifyingKey,
        signedData: base64Url(new TextEncoder().encode(signed.signedData)),
      });
      setAccepted(result);
      setDraft(EMPTY_DRAFT);
      onSubmitted?.();
    } catch (error) {
      setFailure(failureCode(error));
    } finally {
      setBusy(false);
    }
  }, [api, draft, epoch, market, nowMs, onSubmitted, ready, session, wallet]);

  return (
    <section className="workspace-panel" aria-labelledby="ticket-title">
      <h2 id="ticket-title">Private limit order</h2>

      {session === undefined || wallet === undefined ? (
        <p className="workspace-placeholder">Connect a wallet to place an order.</p>
      ) : (
        <form
          className="ticket-form"
          onSubmit={event => { event.preventDefault(); void submit(); }}
        >
          <fieldset className="ticket-side" disabled={busy}>
            <legend>Side</legend>
            {(["BUY", "SELL"] as const).map(side => (
              <label key={side}>
                <input
                  type="radio"
                  name="side"
                  value={side}
                  checked={draft.side === side}
                  onChange={() => { setDraft({ ...draft, side }); }}
                />
                <span>{side}</span>
              </label>
            ))}
          </fieldset>

          <label className="ticket-field">
            <span>Quantity (atomic units)</span>
            <input
              inputMode="numeric"
              value={draft.quantityLots}
              disabled={busy}
              onChange={event => { setDraft({ ...draft, quantityLots: event.target.value }); }}
            />
            <small>Multiple of {market.lotSizeAtomic}</small>
          </label>

          <label className="ticket-field">
            <span>Limit price (atomic units)</span>
            <input
              inputMode="numeric"
              value={draft.limitPriceTicks}
              disabled={busy}
              onChange={event => { setDraft({ ...draft, limitPriceTicks: event.target.value }); }}
            />
            <small>Multiple of {market.tickSizeAtomic}</small>
          </label>

          <label className="ticket-field">
            <span>Minimum fill (optional)</span>
            <input
              inputMode="numeric"
              value={draft.minFillLots}
              disabled={busy}
              onChange={event => { setDraft({ ...draft, minFillLots: event.target.value }); }}
            />
          </label>

          <label className="ticket-checkbox">
            <input
              type="checkbox"
              checked={draft.allowPartial}
              disabled={busy}
              onChange={event => { setDraft({ ...draft, allowPartial: event.target.checked }); }}
            />
            <span>Allow partial fill</span>
          </label>

          {problems.length > 0 && (
            <ul className="ticket-problems">
              {problems.map(problem => (
                <li key={problem}>{PROBLEM_TEXT[problem] ?? problem}</li>
              ))}
            </ul>
          )}

          <button className="ticket-submit" type="submit" disabled={!ready || busy}>
            {busy ? "Encrypting and signing…" : "Encrypt and submit"}
          </button>
          {busy && slowWallet && (
            <p className="wallet-waiting" role="status">
              <strong>Approve the signature in Lace.</strong>{" "}
              If no Lace window opened, click the Lace icon in your browser toolbar.
            </p>
          )}
        </form>
      )}

      {accepted !== undefined && (
        <p className="workspace-notice workspace-notice-info">
          <strong>Order accepted for chain admission.</strong>{" "}
          <span>
            State <code>{accepted.state}</code>.{" "}
            {demoMode
              ? "The simulated chain admits it within a few seconds; it is matched when the epoch closes."
              : "The admission worker now proves and submits its commitment on Midnight; the transaction appears under Your orders once it finalizes."}
          </span>
        </p>
      )}

      {failure !== undefined && (
        <p className="workspace-notice workspace-notice-error">
          <strong>Order not submitted.</strong>{" "}
          <span>Reported <code>{failure}</code>. Nothing was recorded.</span>
        </p>
      )}

      <p className="wallet-note">
        Side, price, quantity and minimum fill are encrypted in this browser before
        the request is sent. <strong>The matcher decrypts orders to match them</strong> —
        V1 does not hide order contents from the matcher, only from the public chain
        and other traders.
      </p>
    </section>
  );
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
