import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import QRCode from 'qrcode.react';

const DEFAULT_BACKEND_URL = 'http://localhost:3001';

const ITEM_W = 120;

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

  const [lastOutcome, setLastOutcome] = useState(null);
  const [payoutStatus, setPayoutStatus] = useState(null);

  const socketRef = useRef(null);
  const viewportRef = useRef(null);

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
      const fillerCount = 28;
      const filler = Array.from({ length: fillerCount }, () => opts[Math.floor(Math.random() * opts.length)]);
      const tail = Array.from({ length: 8 }, () => opts[Math.floor(Math.random() * opts.length)]);
      const items = [...filler, payoutAmount, ...tail];

      setSpinItems(items);

      const viewportW = viewportRef.current?.clientWidth || 600;
      const pointerX = viewportW / 2;
      const targetIndex = filler.length;
      const targetCenter = targetIndex * ITEM_W + ITEM_W / 2;
      const shift = Math.max(0, targetCenter - pointerX);

      requestAnimationFrame(() => {
        setSpinAnimating(false);
        setSpinTransitionMs(0);
        setSpinShift(0);

        requestAnimationFrame(() => {
          setSpinAnimating(true);
          setSpinTransitionMs(4200);
          setSpinShift(shift);
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
    localStorage.setItem('slidesLightningAddress', lightningAddress);
  }, [lightningAddress]);

  useEffect(() => {
    localStorage.setItem('slidesBetAmount', betAmount);
  }, [betAmount]);

  const paymentUrl = useMemo(() => {
    return paymentInfo?.speedInterfaceUrl || paymentInfo?.hostedInvoiceUrl || null;
  }, [paymentInfo]);

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

  const trackStyle = useMemo(() => {
    const easing = 'cubic-bezier(0.10, 0.80, 0.10, 1.00)';
    return {
      transform: `translateX(${-spinShift}px)`,
      transition: spinAnimating ? `transform ${spinTransitionMs}ms ${easing}` : 'none'
    };
  }, [spinShift, spinAnimating, spinTransitionMs]);

  const onTrackTransitionEnd = useCallback(() => {
    if (spinAnimating) {
      setSpinAnimating(false);
      setSpinTransitionMs(0);
    }
  }, [spinAnimating]);

  return (
    <div className="container">
      <div className="header">
        <div className="brand">
          <h1>BTC Slides</h1>
          <div className="muted">Pick a bet, pay, then the slides spin and you win whatever lands on the pointer.</div>
        </div>
        <div className="muted">{socketConnected ? `Connected (${socketId?.slice(0, 6)})` : 'Offline'}</div>
      </div>

      <div className="card">
        <div className="row">
          <div>
            <label className="label">Speed Lightning Address</label>
            <input
              className="input"
              value={lightningAddress}
              onChange={(e) => setLightningAddress(e.target.value)}
              placeholder="e.g. username@speed.app"
              autoComplete="off"
            />
          </div>
          <div>
            <label className="label">Bet Amount (SATS)</label>
            <select className="select" value={betAmount} onChange={(e) => setBetAmount(e.target.value)}>
              {betOptions.map((b) => (
                <option key={b} value={String(b)}>{b}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="actions">
          <button className="button" disabled={!canStart} onClick={startSpin}>Start</button>
          <button
            className="button secondary"
            onClick={() => {
              setStatus('');
              setShowPaymentModal(false);
            }}
          >
            Clear
          </button>
        </div>

        {status ? <div className="status">{status}</div> : null}

        <div className="slidesWrap">
          <div className="viewport" ref={viewportRef}>
            <div className="pointer" />
            <div className="track" style={trackStyle} onTransitionEnd={onTrackTransitionEnd}>
              {spinItems.map((v, idx) => (
                <div className="item" key={`${idx}-${v}`}>{v}</div>
              ))}
            </div>
          </div>

          {lastOutcome ? (
            <div className="status">
              Bet: <b>{lastOutcome.betAmount}</b> SATS | Outcome: <b>{lastOutcome.payoutAmount}</b> SATS
            </div>
          ) : null}

          {payoutStatus ? (
            <div className="status">
              {payoutStatus.ok ? (
                <span>Payout status: <b>sent</b></span>
              ) : (
                <span>Payout status: <b>failed</b></span>
              )}
            </div>
          ) : null}
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
              After payment, the spin will start and your winnings (if any) will be sent to your lightning address.
            </div>

            {paymentUrl ? (
              <div className="actions">
                <button className="button" onClick={onPay} disabled={payButtonLoading}>
                  {payButtonLoading ? 'Opening…' : 'Pay'}
                </button>
                <a className="button secondary" href={paymentUrl} target="_blank" rel="noopener noreferrer">Open Invoice</a>
              </div>
            ) : null}

            {paymentUrl ? (
              <div className="qrWrap">
                <QRCode value={paymentUrl} size={220} includeMargin />
              </div>
            ) : null}

            {paymentVerified ? (
              <div className="status">Payment verified. Waiting for spin result…</div>
            ) : (
              <div className="status">Waiting for payment confirmation…</div>
            )}

            <div className="small">Invoice ID: {paymentInfo.invoiceId}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
