import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import QRCode from 'qrcode.react';

const DEFAULT_BACKEND_URL = 'http://localhost:3001';

const ITEM_W = 140;

const RARITY = {
  common: { label: 'Common' },
  uncommon: { label: 'Uncommon' },
  rare: { label: 'Rare' },
  epic: { label: 'Epic' },
  legendary: { label: 'Legendary' }
};

function buildRarityMap(payoutOptions) {
  const vals = Array.from(new Set((payoutOptions || []).map((n) => Number(n)).filter((n) => Number.isFinite(n)))).sort((a, b) => a - b);
  if (vals.length === 0) return {};

  const nonZero = vals.filter((v) => v > 0);
  const sorted = nonZero.length > 0 ? nonZero : vals;
  const n = sorted.length;

  function tierForIndex(i) {
    if (n <= 1) return 'legendary';
    const p = i / (n - 1);
    if (p < 0.25) return 'uncommon';
    if (p < 0.5) return 'rare';
    if (p < 0.75) return 'epic';
    return 'legendary';
  }

  const m = {};
  for (const v of vals) {
    if (v === 0) {
      m[v] = 'common';
      continue;
    }
    const idx = Math.max(0, sorted.indexOf(v));
    m[v] = tierForIndex(idx);
  }
  return m;
}

function copyToClipboard(text) {
  const v = String(text || '');
  if (!v) return Promise.resolve(false);

  if (navigator?.clipboard?.writeText) {
    return navigator.clipboard.writeText(v).then(
      () => true,
      () => false,
    );
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = v;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return Promise.resolve(!!ok);
  } catch {
    return Promise.resolve(false);
  }
}

function openPaymentUrlSafely(url) {
  try {
    const preWin = window.open('', '_blank', 'noopener,noreferrer');
    if (preWin && typeof preWin.location !== 'undefined') {
      preWin.location.href = url;
      return true;
    }
  } catch {
  }

  try {
    const w = window.open(url, '_blank', 'noopener,noreferrer');
    if (w) return true;
  } catch {
  }

  try {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return true;
  } catch {
  }

  try {
    window.location.href = url;
    return true;
  } catch {
  }

  return false;
}

export default function App() {
  const backendUrl = import.meta.env.VITE_BACKEND_URL || DEFAULT_BACKEND_URL;

  const [socketConnected, setSocketConnected] = useState(false);
  const [socketId, setSocketId] = useState(null);

  const [lightningAddress, setLightningAddress] = useState(() => localStorage.getItem('slidesLightningAddress') || '');
  const [betAmount, setBetAmount] = useState(() => localStorage.getItem('slidesBetAmount') || '20');

  const [betOptions, setBetOptions] = useState([20, 100, 300, 500, 1000, 5000, 10000]);

  const [status, setStatus] = useState('');

  const [paymentInfo, setPaymentInfo] = useState(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [payButtonLoading, setPayButtonLoading] = useState(false);
  const [paymentVerified, setPaymentVerified] = useState(false);

  const [spinItems, setSpinItems] = useState([0, 20, 50, 80, 100, 0, 20, 50, 80, 100]);
  const [spinShift, setSpinShift] = useState(0);
  const [spinAnimating, setSpinAnimating] = useState(false);
  const [spinTransitionMs, setSpinTransitionMs] = useState(0);
  const [spinStage, setSpinStage] = useState(0);
  const [spinFlash, setSpinFlash] = useState(false);
  const [winnerIndex, setWinnerIndex] = useState(null);
  const [rarityByValue, setRarityByValue] = useState({});

  const [copyNotice, setCopyNotice] = useState(null);

  const [lastOutcome, setLastOutcome] = useState(null);
  const [payoutStatus, setPayoutStatus] = useState(null);

  const socketRef = useRef(null);
  const viewportRef = useRef(null);
  const spinTargetShiftRef = useRef(0);
  const flashTimeoutRef = useRef(null);
  const copyTimeoutRef = useRef(null);

  useEffect(() => {
    const s = io(backendUrl, {
      transports: ['websocket', 'polling'],
      withCredentials: true
    });

    socketRef.current = s;

    const onConnect = () => {
      setSocketConnected(true);
      setSocketId(s.id);
      setStatus('');
    };

    const onDisconnect = () => {
      setSocketConnected(false);
      setStatus('Disconnected from server');
      setPayButtonLoading(false);
    };

    const onServerInfo = (info) => {
      if (Array.isArray(info?.betOptions) && info.betOptions.length > 0) {
        setBetOptions(info.betOptions);
      }
    };

    const onPaymentRequest = (data) => {
      setPaymentInfo(data);
      setShowPaymentModal(true);
      setPayButtonLoading(false);
      setPaymentVerified(false);
      setPayoutStatus(null);
      setLastOutcome(null);
      setWinnerIndex(null);
      setStatus(`Pay ${data.amountSats} SATS to spin`);
    };

    const onPaymentVerified = () => {
      setPaymentVerified(true);
      setStatus('Payment verified. Spinning...');
      setShowPaymentModal(false);
      setPayButtonLoading(false);
    };

    const onSpinOutcome = ({ betAmount: bet, payoutAmount, payoutOptions }) => {
      setShowPaymentModal(false);
      setLastOutcome({ betAmount: bet, payoutAmount, payoutOptions });
      setStatus(`Result: ${payoutAmount} SATS`);

      const opts = Array.isArray(payoutOptions) && payoutOptions.length > 0 ? payoutOptions : [0, bet];
      setRarityByValue(buildRarityMap(opts));
      const fillerCount = 34;
      const filler = Array.from({ length: fillerCount }, () => opts[Math.floor(Math.random() * opts.length)]);
      const tail = Array.from({ length: 10 }, (_, i) => {
        if (i >= 6) {
          return i % 2 === 0 ? payoutAmount : opts[Math.floor(Math.random() * opts.length)];
        }
        return opts[Math.floor(Math.random() * opts.length)];
      });
      const items = [...filler, payoutAmount, ...tail];

      setSpinItems(items);

      const viewportW = viewportRef.current?.clientWidth || 600;
      const pointerX = viewportW / 2;
      const targetIndex = filler.length;
      setWinnerIndex(targetIndex);
      const targetCenter = targetIndex * ITEM_W + ITEM_W / 2;
      const shift = Math.max(0, targetCenter - pointerX);

      const overshoot = Math.min(42, Math.max(18, Math.round(ITEM_W * 0.18)));
      spinTargetShiftRef.current = shift;

      requestAnimationFrame(() => {
        setSpinAnimating(false);
        setSpinTransitionMs(0);
        setSpinShift(0);
        setSpinStage(0);
        setSpinFlash(false);

        requestAnimationFrame(() => {
          setSpinAnimating(true);
          setSpinTransitionMs(3900);
          setSpinStage(1);
          setSpinShift(shift + overshoot);
        });
      });
    };

    const onPayoutSent = ({ payoutAmount, recipient }) => {
      setPayoutStatus({ ok: true, payoutAmount, recipient });
      setStatus(payoutAmount > 0 ? `Paid ${payoutAmount} SATS to ${recipient}` : 'No payout this spin (0 SATS)');
    };

    const onPayoutFailed = ({ payoutAmount, recipient, error }) => {
      setPayoutStatus({ ok: false, payoutAmount, recipient, error });
      setStatus(`Payout failed: ${error}`);
    };

    const onPaymentFailed = () => {
      setStatus('Payment failed. Please try again.');
      setPayButtonLoading(false);
      setShowPaymentModal(false);
      setPaymentInfo(null);
    };

    const onPaymentExpired = () => {
      setStatus('Invoice expired. Please start again.');
      setPayButtonLoading(false);
      setShowPaymentModal(false);
      setPaymentInfo(null);
    };

    const onErrorMessage = (msg) => {
      setStatus(msg?.message || 'Error');
      setPayButtonLoading(false);
    };

    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);
    s.on('serverInfo', onServerInfo);
    s.on('paymentRequest', onPaymentRequest);
    s.on('paymentVerified', onPaymentVerified);
    s.on('spinOutcome', onSpinOutcome);
    s.on('payoutSent', onPayoutSent);
    s.on('payoutFailed', onPayoutFailed);
    s.on('paymentFailed', onPaymentFailed);
    s.on('paymentExpired', onPaymentExpired);
    s.on('errorMessage', onErrorMessage);

    return () => {
      s.disconnect();
    };
  }, [backendUrl]);

  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem('slidesLightningAddress', lightningAddress);
  }, [lightningAddress]);

  useEffect(() => {
    localStorage.setItem('slidesBetAmount', betAmount);
  }, [betAmount]);

  const paymentUrl = useMemo(() => {
    return paymentInfo?.speedInterfaceUrl || paymentInfo?.hostedInvoiceUrl || null;
  }, [paymentInfo]);

  const selectedBet = useMemo(() => Number(betAmount), [betAmount]);

  const canStart = socketConnected && lightningAddress.trim() && betAmount;

  const startSpin = useCallback(() => {
    const s = socketRef.current;
    if (!s) return;

    const addr = lightningAddress.trim();
    if (!addr) {
      setStatus('Enter your Speed lightning address');
      return;
    }

    const bet = Number(betAmount);
    if (!Number.isFinite(bet)) {
      setStatus('Choose a bet');
      return;
    }

    setStatus('Creating invoice...');
    setShowPaymentModal(false);
    setPaymentVerified(false);
    setPayoutStatus(null);
    setLastOutcome(null);
    setWinnerIndex(null);
    setPayButtonLoading(false);

    s.emit('startSpin', { lightningAddress: addr, betAmount: bet });
  }, [lightningAddress, betAmount]);

  const onPay = useCallback(() => {
    if (!paymentUrl) {
      setStatus('No payment URL available.');
      return;
    }
    const opened = openPaymentUrlSafely(paymentUrl);
    if (opened) {
      setPayButtonLoading(true);
    } else {
      setPayButtonLoading(false);
      setStatus('Popup blocked. Use the “Open Invoice” link or scan the QR.');
    }
  }, [paymentUrl]);

  const showCopied = useCallback((label) => {
    setCopyNotice(label);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopyNotice(null), 1400);
  }, []);

  const copyValue = useCallback(async (label, value) => {
    const ok = await copyToClipboard(value);
    showCopied(ok ? `${label} copied` : 'Copy failed');
  }, [showCopied]);

  const trackStyle = useMemo(() => {
    const easing = spinStage === 2
      ? 'cubic-bezier(0.18, 0.90, 0.25, 1.15)'
      : 'cubic-bezier(0.08, 0.85, 0.14, 1.00)';
    return {
      transform: `translateX(${-spinShift}px)`,
      transition: spinAnimating ? `transform ${spinTransitionMs}ms ${easing}` : 'none'
    };
  }, [spinShift, spinAnimating, spinTransitionMs, spinStage]);

  const onTrackTransitionEnd = useCallback(() => {
    if (!spinAnimating) return;

    if (spinStage === 1) {
      setSpinStage(2);
      setSpinTransitionMs(520);
      setSpinShift(spinTargetShiftRef.current);
      return;
    }

    if (spinStage === 2) {
      setSpinAnimating(false);
      setSpinTransitionMs(0);
      setSpinStage(0);
      setSpinFlash(true);
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
      flashTimeoutRef.current = setTimeout(() => setSpinFlash(false), 700);
    }
  }, [spinAnimating, spinStage]);

  return (
    <div className="shell">
      <div className="topbar">
        <div className="logo">BTC Slides</div>
        <div className={`conn ${socketConnected ? 'ok' : 'bad'}`}>{socketConnected ? `Connected (${socketId?.slice(0, 6)})` : 'Offline'}</div>
      </div>

      <div className="layout">
        <div className="panel">
          <div className="panelTitle">Manual</div>

          <div className="field">
            <div className="fieldLabel">Lightning Address</div>
            <div className="inputRow">
              <input
                className="input"
                value={lightningAddress}
                onChange={(e) => setLightningAddress(e.target.value)}
                placeholder="username@speed.app"
                autoComplete="off"
              />
              <button
                className="iconButton"
                onClick={() => copyValue('Lightning address', lightningAddress)}
                disabled={!lightningAddress.trim()}
                type="button"
              >
                Copy
              </button>
            </div>
          </div>

          <div className="field">
            <div className="fieldLabel">Bet Amount (SATS)</div>
            <div className="betGrid">
              {betOptions.map((b) => (
                <button
                  key={b}
                  type="button"
                  className={`betPill ${selectedBet === b ? 'active' : ''}`}
                  onClick={() => setBetAmount(String(b))}
                >
                  {b}
                </button>
              ))}
            </div>
          </div>

          <button className="primary" disabled={!canStart} onClick={startSpin}>
            Spin
          </button>

          {status ? <div className="panelNote">{status}</div> : <div className="panelNote muted">Ready.</div>}
          {copyNotice ? <div className="toast">{copyNotice}</div> : null}

          <div className="legend">
            {Object.entries(RARITY).map(([k, v]) => (
              <div className={`legendItem rarity-${k}`} key={k}>
                <span className="legendDot" />
                <span className="legendText">{v.label}</span>
              </div>
            ))}
          </div>

          {lastOutcome ? (
            <div className="result">
              <div className="resultRow">
                <span className="muted">Bet</span>
                <b>{lastOutcome.betAmount} SATS</b>
              </div>
              <div className="resultRow">
                <span className="muted">Payout</span>
                <b>{lastOutcome.payoutAmount} SATS</b>
              </div>
              {payoutStatus ? (
                <div className="resultRow">
                  <span className="muted">Status</span>
                  <b>{payoutStatus.ok ? 'Paid' : 'Failed'}</b>
                </div>
              ) : null}
            </div>
          ) : null}

          <button
            className="linkButton"
            type="button"
            onClick={() => {
              setStatus('');
              setShowPaymentModal(false);
            }}
          >
            Clear
          </button>
        </div>

        <div className="stage">
          <div className="stageCard">
            <div className="stageTop">
              <div className="stageTitle">Slide</div>
              <div className="stageSub">Pay, then land on a rarity-themed payout.</div>
            </div>

            <div className={`viewport light ${spinFlash ? 'flash' : ''}`} ref={viewportRef}>
              <div className="pointer" />
              <div
                className={`track ${spinAnimating ? 'spinning' : ''} ${spinStage === 2 ? 'settling' : ''}`}
                style={trackStyle}
                onTransitionEnd={onTrackTransitionEnd}
              >
                {spinItems.map((v, idx) => {
                  const tier = rarityByValue?.[Number(v)] || (Number(v) === 0 ? 'common' : 'uncommon');
                  return (
                    <div className={`item rarity-${tier} ${winnerIndex === idx ? 'winner' : ''}`} key={`${idx}-${v}`}>
                      <div className="itemInner">
                        <div className="itemTier">{RARITY[tier]?.label || 'Common'}</div>
                        <div className="itemValue">{v}</div>
                        <div className="itemSub">SATS</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {showPaymentModal && paymentInfo ? (
        <div className="modalOverlay" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modalHeader">
              <div className="modalTitle">Pay {paymentInfo.amountSats} SATS</div>
              <button
                className="button secondary"
                onClick={() => {
                  setShowPaymentModal(false);
                  setPayButtonLoading(false);
                }}
              >
                Close
              </button>
            </div>

            <div className="muted">
              Complete payment in Speed. After confirmation, the reel will spin and winnings (if any) will be paid to your lightning address.
            </div>

            {paymentUrl ? (
              <div className="actions">
                <button className="button" onClick={onPay} disabled={payButtonLoading}>
                  {payButtonLoading ? 'Opening…' : 'Pay'}
                </button>
                <a className="button secondary" href={paymentUrl} target="_blank" rel="noopener noreferrer">Open Invoice</a>
              </div>
            ) : null}

            {paymentUrl || paymentInfo?.lightningInvoice ? (
              <div className="qrGrid">
                {paymentInfo?.lightningInvoice ? (
                  <div className="qrCard">
                    <div className="qrTitle">Lightning Invoice (BOLT11)</div>
                    <div className="qrWrap">
                      <QRCode value={paymentInfo.lightningInvoice} size={220} includeMargin />
                    </div>
                    <div className="copyRow">
                      <button
                        className="button secondary"
                        onClick={() => copyValue('BOLT11 invoice', paymentInfo.lightningInvoice)}
                        type="button"
                      >
                        Copy BOLT11
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="qrCard">
                    <div className="qrTitle">Lightning Invoice</div>
                    <div className="muted" style={{ marginTop: 8 }}>
                      Not available here. Use the hosted invoice.
                    </div>
                  </div>
                )}

                <div className="qrCard">
                  <div className="qrTitle">Hosted Invoice</div>
                  {paymentUrl ? (
                    <div className="qrWrap compact">
                      <QRCode value={paymentUrl} size={190} includeMargin />
                    </div>
                  ) : null}
                  <div className="small monoBox">
                    {paymentUrl || '—'}
                  </div>
                  <div className="copyRow">
                    <button
                      className="button secondary"
                      onClick={() => copyValue('Hosted invoice link', paymentUrl)}
                      disabled={!paymentUrl}
                      type="button"
                    >
                      Copy link
                    </button>
                    {paymentUrl ? (
                      <a className="button secondary" href={paymentUrl} target="_blank" rel="noopener noreferrer">Open</a>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}

            {paymentVerified ? (
              <div className="status">Payment verified. Waiting for spin result…</div>
            ) : (
              <div className="status">Waiting for payment confirmation…</div>
            )}

            <div className="small">Invoice ID: {paymentInfo.invoiceId}</div>
            <div className="copyRow" style={{ marginTop: 8 }}>
              <button className="button secondary" onClick={() => copyValue('Invoice ID', paymentInfo.invoiceId)} type="button">Copy invoice id</button>
              {paymentUrl ? (
                <button className="button secondary" onClick={() => copyValue('Hosted invoice link', paymentUrl)} type="button">Copy link</button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
