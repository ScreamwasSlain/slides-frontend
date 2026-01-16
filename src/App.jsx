import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import QRCode from 'qrcode.react';

const DEFAULT_BACKEND_URL = 'http://localhost:3001';

function getItemWidthPx() {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--itemW');
    const n = Number(String(raw || '').trim().replace('px', ''));
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    // ignore
  }
  return 140;
}

function generateWalletId() {
  try {
    const bytes = new Uint8Array(16);
    const c = globalThis?.crypto;
    if (c?.getRandomValues) c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return `w_${Date.now()}_${Math.random().toString(16).slice(2)}_${Math.random().toString(16).slice(2)}`;
  }
}

function generateWalletSecret() {
  try {
    const bytes = new Uint8Array(32);
    const c = globalThis?.crypto;
    if (c?.getRandomValues) c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return `s_${Date.now()}_${Math.random().toString(16).slice(2)}_${Math.random().toString(16).slice(2)}`;
  }
}

const DEFAULT_PAYOUT_TABLE = {
  20: [0, 20, 50, 80, 100],
  100: [0, 50, 120, 200, 300],
  300: [0, 100, 350, 500, 700],
  500: [0, 200, 400, 800, 1200],
  1000: [0, 300, 1000, 1500, 3000],
  5000: [0, 1000, 3000, 5000, 11000],
  10000: [0, 2000, 5000, 12000, 30000]
};

const DEFAULT_PAYOUT_WEIGHTS = {
  20: [36, 50, 9, 4, 1],
  100: [36, 50, 9, 4, 1],
  300: [36, 50, 9, 4, 1],
  500: [36, 50, 9, 4, 1],
  1000: [36, 50, 9, 4, 1],
  5000: [36, 50, 9, 4, 1],
  10000: [2500, 2500, 2500, 249, 1]
};

const RARITY = {
  common: { label: 'Common' },
  uncommon: { label: 'Uncommon' },
  rare: { label: 'Rare' },
  epic: { label: 'Epic' },
  legendary: { label: 'Legendary' }
};

function buildRarityMap(payoutOptions, payoutWeights) {
  const rawVals = (payoutOptions || []).map((n) => Number(n)).filter((n) => Number.isFinite(n));
  const vals = Array.from(new Set(rawVals)).sort((a, b) => a - b);
  if (vals.length === 0) return {};

  const canUseWeights = Array.isArray(payoutWeights) && payoutWeights.length === (payoutOptions || []).length;
  if (canUseWeights) {
    const weightByVal = new Map();
    let total = 0;
    for (let i = 0; i < payoutOptions.length; i += 1) {
      const v = Number(payoutOptions[i]);
      if (!Number.isFinite(v)) continue;
      const w = Math.max(0, Number(payoutWeights[i]) || 0);
      total += w;
      weightByVal.set(v, (weightByVal.get(v) || 0) + w);
    }

    if (Number.isFinite(total) && total > 0) {
      const m = {};
      if (vals.includes(0)) m[0] = 'common';

      const nonZero = vals
        .filter((v) => v !== 0)
        .map((v) => ({ v, w: weightByVal.get(v) || 0 }))
        .sort((a, b) => {
          if (a.w !== b.w) return a.w - b.w;
          return b.v - a.v;
        });

      const tiersRarestFirst = ['legendary', 'epic', 'rare', 'uncommon'];
      for (let i = 0; i < nonZero.length; i += 1) {
        m[nonZero[i].v] = tiersRarestFirst[i] || 'uncommon';
      }
      return m;
    }
  }

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
  if (!url) return false;
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

function downloadTextFile(filename, text, mime = 'text/plain') {
  try {
    const blob = new Blob([String(text ?? '')], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {
      }
    }, 3000);
    return true;
  } catch {
    return false;
  }
}

export default function App() {
  const backendUrl = import.meta.env.VITE_BACKEND_URL || DEFAULT_BACKEND_URL;
  const keepAliveMs = useMemo(() => {
    const raw = import.meta.env.VITE_KEEPALIVE_MS;
    const n = raw == null ? NaN : Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
    const u = String(backendUrl || '').toLowerCase();
    if (u.includes('localhost') || u.includes('127.0.0.1')) return 0;
    return 4 * 60 * 1000;
  }, [backendUrl]);

  const historyKey = useMemo(() => {
    try {
      let id = localStorage.getItem('slidesWalletId') || '';
      if (!(id && String(id).trim().length >= 32)) {
        id = generateWalletId();
        localStorage.setItem('slidesWalletId', id);
      }
      return `slidesHistory:${id}`;
    } catch {
      return 'slidesHistory:';
    }
  }, []);

  const [history, setHistory] = useState(() => {
    try {
      const raw = localStorage.getItem(historyKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

  const [showHistoryModal, setShowHistoryModal] = useState(false);

  const [socketConnected, setSocketConnected] = useState(false);
  const [socketId, setSocketId] = useState(null);
  const [healthOk, setHealthOk] = useState(null);

  const [walletId] = useState(() => {
    const existing = localStorage.getItem('slidesWalletId');
    if (existing && String(existing).trim().length >= 32) return String(existing).trim();
    const next = generateWalletId();
    localStorage.setItem('slidesWalletId', next);
    return next;
  });

  const [walletSecret] = useState(() => {
    const existing = localStorage.getItem('slidesWalletSecret');
    if (existing && String(existing).trim().length >= 32) return String(existing).trim();
    const next = generateWalletSecret();
    localStorage.setItem('slidesWalletSecret', next);
    return next;
  });

  const [lightningAddress, setLightningAddress] = useState(() => localStorage.getItem('slidesLightningAddress') || '');
  const [betAmount, setBetAmount] = useState(() => localStorage.getItem('slidesBetAmount') || '20');

  const [betOptions, setBetOptions] = useState([20, 100, 300, 500, 1000, 5000, 10000]);
  const [topUpOptions, setTopUpOptions] = useState([1000, 5000, 10000]);
  const [payoutTable, setPayoutTable] = useState(DEFAULT_PAYOUT_TABLE);
  const [payoutWeightsByBet, setPayoutWeightsByBet] = useState(DEFAULT_PAYOUT_WEIGHTS);

  const [walletBalance, setWalletBalance] = useState(0);

  const [showAddCashModal, setShowAddCashModal] = useState(false);
  const [showLegalModal, setShowLegalModal] = useState(false);
  const [legalDoc, setLegalDoc] = useState(null);

  const [status, setStatus] = useState('');

  const [paymentInfo, setPaymentInfo] = useState(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [payButtonLoading, setPayButtonLoading] = useState(false);
  const [paymentVerified, setPaymentVerified] = useState(false);
  const [verifyLoading, setVerifyLoading] = useState(false);

  const [spinItems, setSpinItems] = useState([0, 20, 50, 80, 100, 0, 20, 50, 80, 100]);
  const [spinShift, setSpinShift] = useState(0);
  const [spinAnimating, setSpinAnimating] = useState(false);
  const [spinTransitionMs, setSpinTransitionMs] = useState(0);
  const [spinStage, setSpinStage] = useState(0);
  const [spinFlash, setSpinFlash] = useState(false);
  const [winnerIndex, setWinnerIndex] = useState(null);
  const [rarityByValue, setRarityByValue] = useState({});
  const [spinLocked, setSpinLocked] = useState(false);

  const [copyNotice, setCopyNotice] = useState(null);

  const [lastOutcome, setLastOutcome] = useState(null);
  const [payoutStatus, setPayoutStatus] = useState(null);

  const [compactInfo, setCompactInfo] = useState(() => {
    try {
      return window.matchMedia && window.matchMedia('(max-width: 760px)').matches;
    } catch {
      return false;
    }
  });
  const [infoOpen, setInfoOpen] = useState(false);

  const [editingAddr, setEditingAddr] = useState(false);
  const [addrDraft, setAddrDraft] = useState('');

  const socketRef = useRef(null);
  const viewportRef = useRef(null);
  const trackRef = useRef(null);
  const spinTargetShiftRef = useRef(0);
  const flashTimeoutRef = useRef(null);
  const copyTimeoutRef = useRef(null);
  const pendingOutcomeRef = useRef(null);
  const pendingPayoutUpdateRef = useRef(null);
  const pendingWalletBalanceRef = useRef(null);
  const walletBalanceRef = useRef(0);
  const walletIdRef = useRef(walletId);
  const lightningAddressRef = useRef(lightningAddress);
  const spinRevealPendingRef = useRef(false);

  useEffect(() => {
    walletBalanceRef.current = walletBalance;
  }, [walletBalance]);

  useEffect(() => {
    walletIdRef.current = walletId;
  }, [walletId]);

  useEffect(() => {
    lightningAddressRef.current = lightningAddress;
  }, [lightningAddress]);

  useEffect(() => {
    function syncVhVar() {
      const h = window?.visualViewport?.height || window.innerHeight;
      const vh = Number(h) * 0.01;
      if (Number.isFinite(vh) && vh > 0) {
        document.documentElement.style.setProperty('--vh', `${vh}px`);
      }
    }

    syncVhVar();

    window.addEventListener('resize', syncVhVar);
    window.addEventListener('orientationchange', syncVhVar);

    const vv = window?.visualViewport;
    if (vv && vv.addEventListener) vv.addEventListener('resize', syncVhVar);

    return () => {
      window.removeEventListener('resize', syncVhVar);
      window.removeEventListener('orientationchange', syncVhVar);
      if (vv && vv.removeEventListener) vv.removeEventListener('resize', syncVhVar);
    };
  }, []);

  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 760px)');
    const onChange = () => setCompactInfo(Boolean(mq.matches));
    onChange();

    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);

    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, []);

  useEffect(() => {
    const s = io(backendUrl, {
      transports: ['websocket', 'polling'],
      withCredentials: true,
      timeout: 10000,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 600,
      reconnectionDelayMax: 6000,
      randomizationFactor: 0.2
    });

    socketRef.current = s;

    const logHistory = (entry) => {
      const nowIso = new Date().toISOString();
      const id = `h_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const addr = String(lightningAddressRef.current || '').trim();
      const e = {
        id,
        ts: nowIso,
        ...entry,
        walletId: walletIdRef.current,
        lightningAddress: addr || null
      };

      setHistory((prev) => {
        const cur = Array.isArray(prev) ? prev : [];
        const next = [e, ...cur].slice(0, 200);
        try {
          localStorage.setItem(historyKey, JSON.stringify(next));
        } catch {
        }
        return next;
      });
    };

    const onConnect = () => {
      setSocketConnected(true);
      setSocketId(s.id);
      setStatus('');
    };

    const onDisconnect = () => {
      setSocketConnected(false);
      setStatus('Disconnected. Reconnecting...');
      setPayButtonLoading(false);
      setSpinLocked(false);
      spinRevealPendingRef.current = false;
      pendingOutcomeRef.current = null;
      pendingPayoutUpdateRef.current = null;
      pendingWalletBalanceRef.current = null;
    };

    const onConnectError = (err) => {
      const msg = String(err?.message || err || 'Connection error');
      setSocketConnected(false);
      setStatus(`Connection issue (retrying): ${msg}`);
      setSpinLocked(false);
      spinRevealPendingRef.current = false;
      pendingOutcomeRef.current = null;
      pendingPayoutUpdateRef.current = null;
      pendingWalletBalanceRef.current = null;
    };

    const onReconnectAttempt = () => {
      setStatus('Reconnecting...');
    };

    const onReconnect = () => {
      setStatus('');
    };

    const onServerInfo = (info) => {
      if (Array.isArray(info?.betOptions) && info.betOptions.length > 0) {
        setBetOptions(info.betOptions);
      }

      if (Array.isArray(info?.topUpOptions) && info.topUpOptions.length > 0) {
        setTopUpOptions(info.topUpOptions);
      }

      if (info?.payoutTable && typeof info.payoutTable === 'object') {
        setPayoutTable(info.payoutTable);
      }

      if (info?.payoutWeights && typeof info.payoutWeights === 'object') {
        setPayoutWeightsByBet(info.payoutWeights);
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
      const purpose = String(data?.purpose || 'spin');
      setStatus(purpose === 'topup' ? `Pay ${data.amountSats} SATS to add to wallet` : `Pay ${data.amountSats} SATS to spin`);
    };

    const onPaymentVerified = () => {
      setPaymentVerified(true);
      const purpose = String(paymentInfo?.purpose || 'spin');
      setStatus(purpose === 'topup' ? 'Payment verified. Crediting wallet...' : 'Payment verified. Spinning...');
      setShowPaymentModal(false);
      setPayButtonLoading(false);
    };

    const onWalletBalance = (data) => {
      const incomingWalletId = data?.walletId;
      if (!incomingWalletId || String(incomingWalletId) !== String(walletIdRef.current || '')) {
        return;
      }

      const b = Number(data?.balanceSats);
      if (!Number.isFinite(b)) return;
      const next = Math.max(0, Math.floor(b));

      if (spinRevealPendingRef.current && next > walletBalanceRef.current) {
        pendingWalletBalanceRef.current = next;
        return;
      }

      walletBalanceRef.current = next;
      setWalletBalance(next);
    };

    const onTopUpConfirmed = (data) => {
      const b = Number(data?.balanceSats);
      if (Number.isFinite(b)) {
        walletBalanceRef.current = b;
        setWalletBalance(b);
      }
      const amt = Number(data?.amountSats) || 0;
      logHistory({ type: 'deposit', invoiceId: data?.invoiceId, amountSats: amt, balanceSats: Number.isFinite(b) ? b : undefined });
      setStatus(amt > 0 ? `Wallet topped up: +${amt} SATS` : 'Wallet topped up');
      setShowPaymentModal(false);
      setPayButtonLoading(false);
    };

    const onWithdrawalPending = ({ amountSats, recipient, balanceSats }) => {
      const a = Number(amountSats) || 0;
      logHistory({ type: 'withdraw_pending', amountSats: a, recipient, balanceSats });
      setStatus(a > 0 ? `Withdrawing ${a} SATS...` : 'Withdrawing...');
    };

    const onWithdrawalSent = ({ amountSats, recipient, balanceSats }) => {
      const a = Number(amountSats) || 0;
      logHistory({ type: 'withdraw_sent', amountSats: a, recipient, balanceSats });
      setStatus(a > 0 ? `Withdrawn ${a} SATS to ${recipient}` : `Withdrawn to ${recipient}`);
    };

    const onWithdrawalFailed = ({ amountSats, error, recipient, balanceSats }) => {
      const a = Number(amountSats) || 0;
      logHistory({ type: 'withdraw_failed', amountSats: a, recipient, balanceSats, error });
      setStatus(a > 0 ? `Withdrawal failed for ${a} SATS: ${error}` : `Withdrawal failed: ${error}`);
    };

    const onAutoRefundSent = ({ amountSats, recipient }) => {
      const a = Number(amountSats) || 0;
      logHistory({ type: 'auto_refund_sent', amountSats: a, recipient });
      setStatus(a > 0 ? `Auto-refund sent: ${a} SATS` : 'Auto-refund sent');
    };

    const onAutoRefundFailed = ({ amountSats, error, recipient }) => {
      const a = Number(amountSats) || 0;
      logHistory({ type: 'auto_refund_failed', amountSats: a, recipient, error });
      setStatus(a > 0 ? `Auto-refund failed for ${a} SATS: ${error}` : `Auto-refund failed: ${error}`);
    };

    const onSpinOutcome = ({ betAmount: bet, payoutAmount, payoutOptions, payoutWeights }) => {
      setShowPaymentModal(false);
      pendingOutcomeRef.current = { betAmount: bet, payoutAmount, payoutOptions };
      spinRevealPendingRef.current = true;

      const opts = Array.isArray(payoutOptions) && payoutOptions.length > 0 ? payoutOptions : [0, bet];
      const weights = Array.isArray(payoutWeights) && payoutWeights.length === opts.length ? payoutWeights : null;
      setRarityByValue(buildRarityMap(opts, weights));

      function sampleFromOpts() {
        if (!weights) return opts[Math.floor(Math.random() * opts.length)];
        const total = weights.reduce((a, b) => a + Math.max(0, Number(b) || 0), 0);
        if (!Number.isFinite(total) || total <= 0) return opts[Math.floor(Math.random() * opts.length)];

        let r = Math.random() * total;
        for (let i = 0; i < opts.length; i += 1) {
          r -= Math.max(0, Number(weights[i]) || 0);
          if (r < 0) return opts[i];
        }
        return opts[opts.length - 1];
      }

      const fillerCount = 60;
      const tailCount = 14;
      const totalCount = fillerCount + 1 + tailCount;

      const base = opts.length > 0 ? opts : [0, bet];
      const startOffset = Math.floor(Math.random() * base.length);
      const items = Array.from({ length: totalCount }, (_, i) => base[(i + startOffset) % base.length]);
      const targetIndex = fillerCount;
      items[targetIndex] = payoutAmount;

      setSpinItems(items);

      const itemW = getItemWidthPx();

      const viewportW = viewportRef.current?.clientWidth || 600;
      const pointerX = viewportW / 2;
      
      setWinnerIndex(targetIndex);
      const targetCenter = targetIndex * itemW + itemW / 2;
      const shift = Math.max(0, targetCenter - pointerX);

      const overshoot = Math.min(28, Math.max(10, Math.round(itemW * 0.12)));
      spinTargetShiftRef.current = shift;

      const firstStageShift = Math.max(0, shift - overshoot);

      requestAnimationFrame(() => {
        setSpinAnimating(false);
        setSpinTransitionMs(0);
        setSpinShift(0);
        setSpinStage(0);
        setSpinFlash(false);

        requestAnimationFrame(() => {
          try {
            trackRef.current?.getBoundingClientRect();
          } catch {
          }
          setSpinAnimating(true);
          setSpinTransitionMs(8200);
          setSpinStage(1);
          setSpinShift(firstStageShift);
        });
      });
    };

    const onPayoutSent = ({ payoutAmount, recipient, creditedToWallet, balanceSats }) => {
      const a = Number(payoutAmount) || 0;
      const credited = Boolean(creditedToWallet) || String(recipient || '') === 'wallet';
      const payoutObj = { ok: true, payoutAmount: a, recipient: credited ? 'wallet' : recipient, creditedToWallet: credited, balanceSats };
      const statusText = a <= 0
        ? 'No win this spin (0 SATS)'
        : (credited
          ? (() => {
            const b = Number(balanceSats);
            return Number.isFinite(b) ? `Won ${a} SATS (added to wallet, balance ${b})` : `Won ${a} SATS (added to wallet)`;
          })()
          : `Paid ${a} SATS to ${recipient}`);

      if (spinRevealPendingRef.current || spinAnimating || spinStage !== 0) {
        pendingPayoutUpdateRef.current = { payoutStatus: payoutObj, statusText };
        return;
      }

      setPayoutStatus(payoutObj);
      setStatus(statusText);
    };

    const onPayoutFailed = ({ payoutAmount, recipient, error }) => {
      const a = Number(payoutAmount) || 0;
      const payoutObj = { ok: false, payoutAmount: a, recipient, error };
      const statusText = `Payout failed: ${error}`;

      if (spinRevealPendingRef.current || spinAnimating || spinStage !== 0) {
        pendingPayoutUpdateRef.current = { payoutStatus: payoutObj, statusText };
        return;
      }

      setPayoutStatus(payoutObj);
      setStatus(statusText);
    };

    const onPaymentFailed = () => {
      setStatus('Payment failed. Please try again.');
      setPayButtonLoading(false);
      setShowPaymentModal(false);
      setPaymentInfo(null);
      setSpinLocked(false);
      spinRevealPendingRef.current = false;
      pendingOutcomeRef.current = null;
      pendingPayoutUpdateRef.current = null;
      pendingWalletBalanceRef.current = null;
    };

    const onPaymentExpired = () => {
      setStatus('Invoice expired. Please start again.');
      setPayButtonLoading(false);
      setShowPaymentModal(false);
      setPaymentInfo(null);
      setSpinLocked(false);
      spinRevealPendingRef.current = false;
      pendingOutcomeRef.current = null;
      pendingPayoutUpdateRef.current = null;
      pendingWalletBalanceRef.current = null;
    };

    const onErrorMessage = (msg) => {
      setStatus(msg?.message || 'Error');
      setPayButtonLoading(false);
      setSpinLocked(false);
      spinRevealPendingRef.current = false;
      pendingOutcomeRef.current = null;
      pendingPayoutUpdateRef.current = null;
      pendingWalletBalanceRef.current = null;
    };

    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);
    s.on('connect_error', onConnectError);
    s.io.on('reconnect_attempt', onReconnectAttempt);
    s.io.on('reconnect', onReconnect);
    s.on('serverInfo', onServerInfo);
    s.on('paymentRequest', onPaymentRequest);
    s.on('paymentVerified', onPaymentVerified);
    s.on('spinOutcome', onSpinOutcome);
    s.on('payoutSent', onPayoutSent);
    s.on('payoutFailed', onPayoutFailed);
    s.on('paymentFailed', onPaymentFailed);
    s.on('paymentExpired', onPaymentExpired);
    s.on('errorMessage', onErrorMessage);
    s.on('walletBalance', onWalletBalance);
    s.on('topUpConfirmed', onTopUpConfirmed);
    s.on('withdrawalPending', onWithdrawalPending);
    s.on('withdrawalSent', onWithdrawalSent);
    s.on('withdrawalFailed', onWithdrawalFailed);
    s.on('autoRefundSent', onAutoRefundSent);
    s.on('autoRefundFailed', onAutoRefundFailed);

    return () => {
      s.disconnect();
    };
  }, [backendUrl, historyKey]);

  useEffect(() => {
    if (keepAliveMs === 0) return;
    const base = String(backendUrl || '').replace(/\/$/, '');
    if (!base) return;
    const url = `${base}/health`;

    let stopped = false;

    const ping = () => {
      if (stopped) return;
      fetch(url, { method: 'GET', cache: 'no-store' })
        .then((r) => {
          if (stopped) return;
          setHealthOk(Boolean(r && r.ok));
        })
        .catch(() => {
          if (stopped) return;
          setHealthOk(false);
        });
    };

    const intervalMs = socketConnected ? keepAliveMs : Math.min(10000, Math.max(2500, keepAliveMs || 10000));
    ping();
    const t = setInterval(ping, intervalMs);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [backendUrl, keepAliveMs, socketConnected]);

  useEffect(() => {
    const s = socketRef.current;
    if (!s) return;
    if (!socketConnected) return;
    s.emit('getWalletBalance', { walletId, walletSecret, lightningAddress: lightningAddress.trim() || null });
  }, [socketConnected, walletId, walletSecret, lightningAddress]);

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
    if (editingAddr) return;
    setAddrDraft(lightningAddress);
  }, [lightningAddress, editingAddr]);

  useEffect(() => {
    localStorage.setItem('slidesBetAmount', betAmount);
  }, [betAmount]);

  const paymentUrl = useMemo(() => {
    return paymentInfo?.speedInterfaceUrl || paymentInfo?.hostedInvoiceUrl || null;
  }, [paymentInfo]);

  const verifyPayment = useCallback(async () => {
    if (!paymentInfo?.invoiceId) return;

    try {
      setVerifyLoading(true);
      const resp = await fetch(
        `${backendUrl.replace(/\/$/, '')}/verify/${encodeURIComponent(paymentInfo.invoiceId)}?socketId=${encodeURIComponent(socketId || '')}`,
        {
          method: 'GET'
        }
      );
      const data = await resp.json().catch(() => null);

      if (!resp.ok) {
        setStatus(data?.error || 'Failed to verify payment');
        return;
      }

      if (data?.paid) {
        const processedOk = data?.processed?.ok === true;
        if (!processedOk) {
          setPaymentVerified(false);
          setStatus('Payment detected, but the server could not match this invoice. Please try again.');
          return;
        }

        setPaymentVerified(true);
        const purpose = String(paymentInfo?.purpose || 'spin');
        setStatus(purpose === 'topup' ? 'Payment detected. Crediting wallet...' : 'Payment detected. Spinning...');
        setShowPaymentModal(false);
      }
    } catch (e) {
      setStatus(String(e?.message || e || 'Failed to verify payment'));
    } finally {
      setVerifyLoading(false);
    }
  }, [backendUrl, paymentInfo?.invoiceId, socketId]);

  useEffect(() => {
    if (!showPaymentModal) return;
    if (!paymentInfo?.invoiceId) return;
    if (!socketConnected) return;
    if (paymentVerified) return;

    let attempts = 0;
    const maxAttempts = 50;

    const interval = setInterval(() => {
      attempts += 1;
      if (attempts > maxAttempts) {
        clearInterval(interval);
        return;
      }
      verifyPayment();
    }, 3000);

    return () => clearInterval(interval);
  }, [showPaymentModal, paymentInfo?.invoiceId, socketConnected, paymentVerified, verifyPayment]);

  const selectedBet = useMemo(() => Number(betAmount), [betAmount]);
  const canAfford = useMemo(() => {
    const bet = Number(selectedBet);
    return Number.isFinite(bet) && bet > 0 && walletBalance >= bet;
  }, [selectedBet, walletBalance]);

  const selectedPayoutOptions = useMemo(() => {
    const bet = Number(selectedBet);
    if (!Number.isFinite(bet)) return [0];
    const opts = Array.isArray(payoutTable?.[bet]) && payoutTable[bet].length > 0
      ? payoutTable[bet]
      : [0, bet];

    const uniq = [];
    const seen = new Set();
    for (const v of opts) {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      if (seen.has(n)) continue;
      seen.add(n);
      uniq.push(n);
    }
    return uniq;
  }, [selectedBet, payoutTable]);

  useEffect(() => {
    if (spinAnimating) return;
    if (spinShift !== 0) return;
    if (winnerIndex !== null) return;
    const bet = Number(betAmount);
    if (!Number.isFinite(bet)) return;

    const opts = Array.isArray(payoutTable?.[bet]) && payoutTable[bet].length > 0
      ? payoutTable[bet]
      : [0, bet];

    const weights = Array.isArray(payoutWeightsByBet?.[bet]) && payoutWeightsByBet[bet].length === opts.length
      ? payoutWeightsByBet[bet]
      : null;

    setRarityByValue(buildRarityMap(opts, weights));

    function sampleFromOpts() {
      if (!weights) return opts[Math.floor(Math.random() * opts.length)];
      const total = weights.reduce((a, b) => a + Math.max(0, Number(b) || 0), 0);
      if (!Number.isFinite(total) || total <= 0) return opts[Math.floor(Math.random() * opts.length)];

      let r = Math.random() * total;
      for (let i = 0; i < opts.length; i += 1) {
        r -= Math.max(0, Number(weights[i]) || 0);
        if (r < 0) return opts[i];
      }
      return opts[opts.length - 1];
    }

    const previewCount = 10;
    setWinnerIndex(null);
    setSpinShift(0);
    setSpinStage(0);
    setSpinTransitionMs(0);
    setSpinFlash(false);
    setSpinItems(Array.from({ length: previewCount }, () => sampleFromOpts()));
  }, [betAmount, payoutTable, payoutWeightsByBet, spinAnimating, spinShift, winnerIndex]);

  const canStart = socketConnected && lightningAddress.trim() && betAmount;

  const startTopUp = useCallback((amount) => {
    const s = socketRef.current;
    if (!s) return;
    const addr = lightningAddress.trim();
    if (!addr) {
      setStatus('Enter your Speed lightning address');
      return;
    }
    const a = Number(amount);
    if (!Number.isFinite(a)) return;

    setStatus('Creating top up invoice...');
    setShowPaymentModal(false);
    setPaymentVerified(false);
    setPayButtonLoading(false);
    s.emit('startTopUp', { walletId, walletSecret, lightningAddress: addr, amountSats: a });
  }, [walletId, walletSecret, lightningAddress]);

  const startSpin = useCallback(() => {
    const s = socketRef.current;
    if (!s) return;
    if (spinLocked || spinRevealPendingRef.current) return;

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

    if (walletBalance < bet) {
      setStatus(`Insufficient wallet balance. Add ${bet - walletBalance} SATS`);
      return;
    }

    setStatus('Spinning...');
    setPayoutStatus(null);
    setLastOutcome(null);
    setWinnerIndex(null);
    pendingOutcomeRef.current = null;
    pendingPayoutUpdateRef.current = null;
    pendingWalletBalanceRef.current = null;
    spinRevealPendingRef.current = true;
    setSpinLocked(true);

    s.emit('startSpin', { walletId, walletSecret, lightningAddress: addr, betAmount: bet });
  }, [walletId, walletSecret, lightningAddress, betAmount, walletBalance, spinLocked]);

  const withdrawWallet = useCallback(() => {
    const s = socketRef.current;
    if (!s) return;

    const addr = lightningAddress.trim();
    if (!addr) {
      setStatus('Enter your Speed lightning address');
      return;
    }

    if (walletBalance <= 0) {
      setStatus('Nothing to withdraw');
      return;
    }

    const ok = window.confirm(`Withdraw ${walletBalance} SATS to ${addr}?`);
    if (!ok) return;

    setStatus('Withdrawing...');
    s.emit('withdraw', { walletId, walletSecret, lightningAddress: addr });
  }, [walletId, walletSecret, lightningAddress, walletBalance]);

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

  const pushHistory = useCallback((entry) => {
    const nowIso = new Date().toISOString();
    const id = `h_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const addr = String(lightningAddressRef.current || '').trim();
    const e = {
      id,
      ts: nowIso,
      ...entry,
      walletId,
      lightningAddress: addr || null
    };

    setHistory((prev) => {
      const cur = Array.isArray(prev) ? prev : [];
      const next = [e, ...cur].slice(0, 200);
      try {
        localStorage.setItem(historyKey, JSON.stringify(next));
      } catch {
      }
      return next;
    });
  }, [historyKey]);

  const clearHistory = useCallback(() => {
    setHistory([]);
    try {
      localStorage.removeItem(historyKey);
    } catch {
    }
  }, [historyKey]);

  const exportHistoryJson = useCallback(() => {
    const exportedAt = new Date().toISOString();
    const addr = String(lightningAddressRef.current || '').trim();
    const rows = Array.isArray(history) ? history : [];
    const payload = {
      exportedAt,
      walletId,
      lightningAddress: addr || null,
      backendUrl,
      entries: rows.map((h) => ({
        ...h,
        walletId: h?.walletId || walletId,
        lightningAddress: h?.lightningAddress || (addr || null)
      }))
    };
    const name = `btc-slides-history_${walletId}_${exportedAt.slice(0, 10)}.json`;
    downloadTextFile(name, JSON.stringify(payload, null, 2), 'application/json');
  }, [backendUrl, history, walletId]);

  const exportHistoryCsv = useCallback(() => {
    const rows = Array.isArray(history) ? history : [];
    const addr = String(lightningAddressRef.current || '').trim();
    const header = [
      'ts',
      'type',
      'walletId',
      'lightningAddress',
      'betAmount',
      'payoutAmount',
      'amountSats',
      'balanceSats',
      'recipient',
      'invoiceId',
      'error'
    ];

    const esc = (v) => {
      const s = String(v ?? '');
      return `"${s.replace(/"/g, '""')}"`;
    };

    const lines = [header.join(',')];
    for (const h of rows) {
      lines.push([
        esc(h?.ts),
        esc(h?.type),
        esc(h?.walletId || walletId),
        esc(h?.lightningAddress || (addr || null)),
        esc(h?.betAmount),
        esc(h?.payoutAmount),
        esc(h?.amountSats),
        esc(h?.balanceSats),
        esc(h?.recipient),
        esc(h?.invoiceId),
        esc(h?.error)
      ].join(','));
    }

    const exportedAt = new Date().toISOString();
    const name = `btc-slides-history_${walletId}_${exportedAt.slice(0, 10)}.csv`;
    downloadTextFile(name, `${lines.join('\n')}\n`, 'text/csv');
  }, [history, walletId]);

  const openLegal = useCallback((doc) => {
    setLegalDoc(doc);
    setShowLegalModal(true);
  }, []);

  const trackStyle = useMemo(() => {
    const easing = spinStage === 2
      ? 'cubic-bezier(0.16, 0.90, 0.22, 1.00)'
      : 'cubic-bezier(0.08, 0.88, 0.16, 1.00)';
    return {
      transform: `translate3d(${-spinShift}px, 0, 0)`,
      transition: spinAnimating ? `transform ${spinTransitionMs}ms ${easing}` : 'none'
    };
  }, [spinShift, spinAnimating, spinTransitionMs, spinStage]);

  const idleActive = useMemo(() => !spinAnimating && spinShift === 0 && winnerIndex === null, [spinAnimating, spinShift, winnerIndex]);

  const idleReelItems = useMemo(() => {
    const base = Array.isArray(selectedPayoutOptions) && selectedPayoutOptions.length > 0
      ? selectedPayoutOptions
      : [0];

    const oneLen = Math.max(12, base.length * 8);
    const one = Array.from({ length: oneLen }, (_, i) => base[i % base.length]);
    return one.concat(one);
  }, [selectedPayoutOptions]);

  const idleInnerStyle = useMemo(() => {
    const itemW = getItemWidthPx();
    const base = Array.isArray(selectedPayoutOptions) && selectedPayoutOptions.length > 0
      ? selectedPayoutOptions
      : [0];
    const oneLen = Math.max(12, base.length * 8);
    const shiftPx = oneLen * itemW;
    return {
      '--idleShift': `${shiftPx}px`
    };
  }, [selectedPayoutOptions]);

  const onTrackTransitionEnd = useCallback(() => {
    if (!spinAnimating) return;

    if (spinStage === 1) {
      setSpinStage(2);
      setSpinTransitionMs(1400);
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

      const pendingBalance = pendingWalletBalanceRef.current;
      if (Number.isFinite(Number(pendingBalance))) {
        pendingWalletBalanceRef.current = null;
        walletBalanceRef.current = Number(pendingBalance);
        setWalletBalance(Number(pendingBalance));
      }

      const pendingOutcome = pendingOutcomeRef.current;
      if (pendingOutcome) {
        pendingOutcomeRef.current = null;
        setLastOutcome(pendingOutcome);
      }

      const pendingPayout = pendingPayoutUpdateRef.current;
      if (pendingPayout) {
        pendingPayoutUpdateRef.current = null;
        setPayoutStatus(pendingPayout.payoutStatus);
        setStatus(pendingPayout.statusText);
      } else if (pendingOutcome) {
        const a = Number(pendingOutcome?.payoutAmount) || 0;
        setStatus(`Result: ${a} SATS`);
      }

      if (pendingOutcome) {
        const bet = Number(pendingOutcome?.betAmount) || 0;
        const payout = Number(pendingOutcome?.payoutAmount) || 0;
        const bal = Number.isFinite(Number(pendingBalance))
          ? Number(pendingBalance)
          : Number(pendingPayout?.payoutStatus?.balanceSats);
        pushHistory({ type: 'spin', betAmount: bet, payoutAmount: payout, balanceSats: Number.isFinite(bal) ? bal : undefined });
      }

      spinRevealPendingRef.current = false;
      setSpinLocked(false);
    }
  }, [spinAnimating, spinStage, pushHistory]);

  return (
    <div className="shell">
      <div className="topbar">
        <div className="logoWrap">
          <div className="logo">BTC Slides</div>
          {editingAddr ? (
            <div className="topAddrEdit">
              <input
                className="input"
                value={addrDraft}
                onChange={(e) => setAddrDraft(e.target.value)}
                placeholder="username@speed.app"
                autoComplete="off"
              />
              <button
                className="button secondary"
                type="button"
                onClick={() => {
                  setLightningAddress(addrDraft);
                  setEditingAddr(false);
                }}
              >
                Save
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() => {
                  setAddrDraft(lightningAddress);
                  setEditingAddr(false);
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              className="logoSub"
              type="button"
              onClick={() => {
                setAddrDraft(lightningAddress);
                setEditingAddr(true);
              }}
            >
              {lightningAddress.trim() || 'Tap to set lightning address'}
            </button>
          )}
        </div>
        <div className={`conn ${socketConnected ? 'ok' : 'bad'}`}>
          {socketConnected
            ? `Connected (${socketId?.slice(0, 6)})`
            : (healthOk === false ? 'Waking server...' : 'Connecting...')}
        </div>
      </div>

      <div className="layout">
        <div className="panel">
          <div className="panelTitle">Manual</div>

          <div className="field">
            <div className="fieldLabel">Wallet Balance</div>
            <div className="walletBalance">{walletBalance} SATS</div>

            <button
              className="button secondary"
              type="button"
              onClick={() => setShowAddCashModal(true)}
              disabled={!socketConnected || !lightningAddress.trim()}
              style={{ marginTop: 10, width: '100%' }}
            >
              Add Cash
            </button>

            <button
              className="button secondary"
              type="button"
              onClick={() => setShowHistoryModal(true)}
              style={{ marginTop: 8, width: '100%' }}
            >
              History
            </button>

            <div className="muted" style={{ marginTop: 10 }}>
              Unused wallet balance auto-refunds after 30 minutes of inactivity.
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

          <button className="primary" disabled={!canStart || !canAfford || spinLocked} onClick={startSpin}>
            Spin
          </button>

          {status ? <div className="panelNote">{status}</div> : <div className="panelNote muted">Ready.</div>}
          {copyNotice ? <div className="toast">{copyNotice}</div> : null}

          {compactInfo ? (
            <details className="infoDetails" open={infoOpen} onToggle={(e) => setInfoOpen(Boolean(e.currentTarget.open))}>
              <summary className="infoSummary">Odds & payouts</summary>
              <div className="infoInner">
                <div className="legend">
                  {Object.entries(RARITY).map(([k, v]) => (
                    <div className={`legendItem rarity-${k}`} key={k}>
                      <span className="legendDot" />
                      <span className="legendText">{v.label}</span>
                    </div>
                  ))}
                </div>

                <div className="payoutsBlock">
                  <div className="payoutsTitle">Possible payouts</div>
                  <div className="payoutsGrid">
                    {selectedPayoutOptions.map((v) => {
                      const tier = rarityByValue?.[Number(v)] || (Number(v) === 0 ? 'common' : 'uncommon');
                      return (
                        <div className={`payoutChip rarity-${tier}`} key={`payout-${selectedBet}-${v}`}>
                          <div className="payoutChipTier">{RARITY[tier]?.label || 'Common'}</div>
                          <div className="payoutChipValue">{v}</div>
                          <div className="payoutChipSub">SATS</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </details>
          ) : (
            <>
              <div className="legend">
                {Object.entries(RARITY).map(([k, v]) => (
                  <div className={`legendItem rarity-${k}`} key={k}>
                    <span className="legendDot" />
                    <span className="legendText">{v.label}</span>
                  </div>
                ))}
              </div>

              <div className="payoutsBlock">
                <div className="payoutsTitle">Possible payouts</div>
                <div className="payoutsGrid">
                  {selectedPayoutOptions.map((v) => {
                    const tier = rarityByValue?.[Number(v)] || (Number(v) === 0 ? 'common' : 'uncommon');
                    return (
                      <div className={`payoutChip rarity-${tier}`} key={`payout-${selectedBet}-${v}`}>
                        <div className="payoutChipTier">{RARITY[tier]?.label || 'Common'}</div>
                        <div className="payoutChipValue">{v}</div>
                        <div className="payoutChipSub">SATS</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

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
                  <b>{payoutStatus.ok ? (payoutStatus.creditedToWallet || String(payoutStatus.recipient || '') === 'wallet' ? 'Credited' : 'Paid') : 'Failed'}</b>
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
              <div className="stageSub">Top up once, then spin from your wallet. Winnings are added to your wallet balance.</div>
            </div>

            <div className={`viewport light ${spinFlash ? 'flash' : ''}`} ref={viewportRef}>
              <div className="pointer" />
              <div
                className={`track ${spinAnimating ? 'spinning' : ''} ${spinStage === 2 ? 'settling' : ''}`}
                style={trackStyle}
                ref={trackRef}
                onTransitionEnd={onTrackTransitionEnd}
              >
                <div className={`trackInner ${idleActive ? 'idle' : ''}`} style={idleActive ? idleInnerStyle : undefined}>
                  {(idleActive ? idleReelItems : spinItems).map((v, idx) => {
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
      </div>

      {showHistoryModal ? (
        <div className="modalOverlay" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modalHeader">
              <div className="modalTitle">History</div>
              <button className="button secondary" type="button" onClick={() => setShowHistoryModal(false)}>
                Close
              </button>
            </div>

            <div className="muted">
              Spins, deposits, withdrawals, and auto-refunds for this wallet.
            </div>

            <div style={{ marginTop: 12, maxHeight: 420, overflow: 'auto' }}>
              {history && history.length > 0 ? (
                history.map((h) => {
                  const ts = h?.ts ? new Date(h.ts).toLocaleString() : '';
                  const t = String(h?.type || '');
                  const amt = Number(h?.amountSats);
                  const bet = Number(h?.betAmount);
                  const payout = Number(h?.payoutAmount);
                  const bal = Number(h?.balanceSats);

                  let title = 'Event';
                  let sub = '';

                  if (t === 'deposit') {
                    title = Number.isFinite(amt) && amt > 0 ? `Deposit +${amt} SATS` : 'Deposit';
                    sub = Number.isFinite(bal) ? `Balance: ${bal} SATS` : '';
                  } else if (t === 'withdraw_pending') {
                    title = Number.isFinite(amt) && amt > 0 ? `Withdrawal requested ${amt} SATS` : 'Withdrawal requested';
                  } else if (t === 'withdraw_sent') {
                    title = Number.isFinite(amt) && amt > 0 ? `Withdrawal sent ${amt} SATS` : 'Withdrawal sent';
                    sub = h?.recipient ? `To: ${h.recipient}` : '';
                  } else if (t === 'withdraw_failed') {
                    title = Number.isFinite(amt) && amt > 0 ? `Withdrawal failed ${amt} SATS` : 'Withdrawal failed';
                    sub = h?.error ? String(h.error) : '';
                  } else if (t === 'auto_refund_sent') {
                    title = Number.isFinite(amt) && amt > 0 ? `Auto-refund sent ${amt} SATS` : 'Auto-refund sent';
                    sub = h?.recipient ? `To: ${h.recipient}` : '';
                  } else if (t === 'auto_refund_failed') {
                    title = Number.isFinite(amt) && amt > 0 ? `Auto-refund failed ${amt} SATS` : 'Auto-refund failed';
                    sub = h?.error ? String(h.error) : '';
                  } else if (t === 'spin') {
                    title = `Spin bet ${Number.isFinite(bet) ? bet : 0} SATS`;
                    sub = `Payout: ${Number.isFinite(payout) ? payout : 0} SATS${Number.isFinite(bal) ? ` • Balance: ${bal} SATS` : ''}`;
                  }

                  return (
                    <div key={String(h?.id || `${t}-${ts}`)} style={{ padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
                        <b>{title}</b>
                        <span className="muted" style={{ fontSize: 12 }}>{ts}</span>
                      </div>
                      {sub ? <div className="muted" style={{ marginTop: 4 }}>{sub}</div> : null}
                    </div>
                  );
                })
              ) : (
                <div className="muted" style={{ marginTop: 12 }}>No history yet.</div>
              )}
            </div>

            <div className="actions" style={{ marginTop: 12 }}>
              <button className="button secondary" type="button" onClick={exportHistoryJson} disabled={!history || history.length === 0}>
                Export JSON
              </button>
              <button className="button secondary" type="button" onClick={exportHistoryCsv} disabled={!history || history.length === 0}>
                Export CSV
              </button>
              <button className="button secondary" type="button" onClick={clearHistory} disabled={!history || history.length === 0}>
                Clear history
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showPaymentModal && paymentInfo ? (
        <div className="modalOverlay" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modalHeader">
              <div className="modalTitle">
                {String(paymentInfo?.purpose || 'spin') === 'topup'
                  ? `Add ${paymentInfo.amountSats} SATS to wallet`
                  : `Pay ${paymentInfo.amountSats} SATS`}
              </div>
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
              {String(paymentInfo?.purpose || 'spin') === 'topup'
                ? 'Complete payment in Speed. After confirmation, your wallet balance will be updated.'
                : 'Complete payment in Speed. After confirmation, the reel will spin and winnings (if any) will be added to your wallet balance.'}
            </div>

            {paymentUrl ? (
              <div className="actions">
                <button className="button" onClick={onPay} disabled={payButtonLoading}>
                  {payButtonLoading ? 'Opening…' : 'Pay'}
                </button>
                <a className="button secondary" href={paymentUrl} target="_blank" rel="noopener noreferrer">Open Invoice</a>
                <button className="button secondary" onClick={verifyPayment} disabled={verifyLoading} type="button">
                  {verifyLoading ? 'Checking…' : "I've paid"}
                </button>
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
                        onClick={() => copyValue('Payment address', paymentInfo.lightningInvoice)}
                        type="button"
                      >
                        copy payment address
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="qrCard">
                    <div className="qrTitle">Lightning Invoice</div>
                    <div className="muted" style={{ marginTop: 8 }}>
                      Not available here. Use the Pay button.
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            {paymentVerified ? (
              <div className="status">
                {String(paymentInfo?.purpose || 'spin') === 'topup'
                  ? 'Payment verified. Waiting for wallet update…'
                  : 'Payment verified. Waiting for spin result…'}
              </div>
            ) : (
              <div className="status">Waiting for payment confirmation…</div>
            )}

            <div className="small">Invoice ID: {paymentInfo.invoiceId}</div>
            <div className="copyRow" style={{ marginTop: 8 }}>
              <button className="button secondary" onClick={() => copyValue('Invoice ID', paymentInfo.invoiceId)} type="button">Copy invoice id</button>
            </div>
          </div>
        </div>
      ) : null}

      {showAddCashModal ? (
        <div className="modalOverlay" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modalHeader">
              <div className="modalTitle">Add Cash</div>
              <button className="button secondary" type="button" onClick={() => setShowAddCashModal(false)}>
                Close
              </button>
            </div>

            <div className="muted">
              Choose an amount to deposit. Your wallet balance will update after payment confirmation.
            </div>

            <div className="actions" style={{ flexWrap: 'wrap' }}>
              {topUpOptions.map((a) => (
                <button
                  key={`addcash-${a}`}
                  className="button"
                  type="button"
                  onClick={() => {
                    setShowAddCashModal(false);
                    startTopUp(a);
                  }}
                  disabled={!socketConnected || !lightningAddress.trim()}
                >
                  Add {a} SATS
                </button>
              ))}
            </div>

            <div className="actions" style={{ marginTop: 10 }}>
              <button
                className="button secondary"
                type="button"
                onClick={withdrawWallet}
                disabled={!socketConnected || !lightningAddress.trim() || walletBalance <= 0}
              >
                Withdraw
              </button>
            </div>

            <div className="legalNote" style={{ marginTop: 12 }}>
              By adding funds, you confirm that you have read and agree to our{' '}
              <button className="legalLink" type="button" onClick={() => openLegal('terms')}>Terms &amp; Conditions</button>
              {' '}and{' '}
              <button className="legalLink" type="button" onClick={() => openLegal('privacy')}>Privacy Policy</button>.
            </div>

            <div className="muted" style={{ marginTop: 12 }}>
              Unused wallet balance auto-refunds after 30 minutes of inactivity.
            </div>
          </div>
        </div>
      ) : null}

      {showLegalModal ? (
        <div className="modalOverlay" role="dialog" aria-modal="true">
          <div className="modal legalModal">
            <div className="modalHeader">
              <div className="modalTitle">{legalDoc === 'privacy' ? 'Privacy Policy' : 'Terms & Conditions'}</div>
              <button
                className="button secondary"
                type="button"
                onClick={() => {
                  setShowLegalModal(false);
                  setLegalDoc(null);
                }}
              >
                Close
              </button>
            </div>

            <div className="legalBody">
              {legalDoc === 'privacy' ? (
                <>
                  <div className="legalP"><b>Effective date:</b> {new Date().toISOString().slice(0, 10)}. <b>Operator:</b> [HyPolar]. <b>Contact:</b> [slatexsense@gmail.com].</div>

                  <div className="legalH">1. Overview</div>
                  <div className="legalP">This Privacy Policy describes how the operator of this BTC Slides deployment (“we”, “us”) collects, uses, and shares information when you use the game. If your local law requires additional disclosures (e.g., GDPR/CCPA), you may need to supplement this policy.</div>

                  <div className="legalH">2. Information we collect</div>
                  <ul className="legalUl">
                    <li>Lightning address you provide (used to bind your in-game wallet and send withdrawals/auto-refunds).</li>
                    <li>Wallet identifiers (e.g., wallet ID) and authentication material (e.g., wallet secret) used to operate the wallet system.</li>
                    <li>Gameplay and wallet events (bets, spins, outcomes, timestamps) for operating the service, fraud prevention, and support.</li>
                    <li>Technical data (IP address, user agent, logs) to secure and maintain the service.</li>
                  </ul>

                  <div className="legalH">3. Payments</div>
                  <div className="legalP">Deposits and withdrawals are processed via a Lightning payment provider. We do not control Lightning network performance. We may store invoice IDs, amounts, and status to prevent double-crediting and to provide customer support.</div>

                  <div className="legalH">4. How we use information</div>
                  <ul className="legalUl">
                    <li>Provide and operate the game and wallet features.</li>
                    <li>Detect and prevent abuse, fraud, and security incidents.</li>
                    <li>Comply with legal obligations and enforce these policies.</li>
                    <li>Improve performance, reliability, and user experience.</li>
                  </ul>

                  <div className="legalH">5. Sharing</div>
                  <div className="legalP">We share information with (a) the payment provider to create invoices and send withdrawals/auto-refunds, and (b) infrastructure providers (hosting, monitoring) to run the service. We may also share information if required by law or to protect our rights and users.</div>

                  <div className="legalH">6. Retention</div>
                  <div className="legalP">We retain information as needed to operate the service, maintain wallet balances, prevent abuse, resolve disputes, and comply with legal obligations. Retention periods can vary depending on jurisdiction and operational needs.</div>

                  <div className="legalH">7. Security</div>
                  <div className="legalP">We use reasonable safeguards, but no system is perfectly secure. You are responsible for securing your devices and any credentials you use. Use the service at your own risk.</div>

                  <div className="legalH">8. Your choices</div>
                  <div className="legalP">You may withdraw your in-game wallet balance to your lightning address. If you stop using the service, the system may auto-refund remaining wallet balance after a period of inactivity.</div>

                  <div className="legalH">9. International users</div>
                  <div className="legalP">By using the service, you understand your information may be processed in the jurisdictions where we or our providers operate.</div>
                </>
              ) : (
                <>
                  <div className="legalP"><b>Effective date:</b> {new Date().toISOString().slice(0, 10)}. <b>Operator:</b> [HyPolar]. <b>Contact:</b> [slatexsense@gmail.com].</div>

                  <div className="legalH">1. Acceptance</div>
                  <div className="legalP">By accessing or using BTC Slides, and/or by depositing sats (or any other value) into the in-game wallet, you agree to these Terms. If you do not agree, do not use the service.</div>

                  <div className="legalH">2. Eligibility and legality</div>
                  <div className="legalP">You must be legally permitted to use this service in your jurisdiction. You are responsible for determining whether your use is lawful, and for any taxes or reporting obligations.</div>

                  <div className="legalH">3. The game and odds</div>
                  <div className="legalP">BTC Slides is an entertainment game. Outcomes are determined by the server’s configured payout tables/weights and may include promotional or onboarding sequences for new wallets. Displayed odds/payouts are informational and may change.</div>

                  <div className="legalH">4. Wallet balance; deposits; withdrawals</div>
                  <ul className="legalUl">
                    <li>Deposits and winnings are credited to an in-game wallet balance.</li>
                    <li>You may request withdrawal to your provided lightning address.</li>
                    <li>Withdrawals and auto-refunds are best-effort and depend on provider/network availability and risk controls.</li>
                  </ul>

                  <div className="legalH">5. No warranties</div>
                  <div className="legalP">The service is provided “as is” and “as available”, without warranties of any kind to the maximum extent permitted by law. We do not guarantee uninterrupted service, error-free operation, exact payout timing, or that the service will meet your requirements.</div>

                  <div className="legalH">6. Limitation of liability</div>
                  <div className="legalP">To the maximum extent permitted by law, we are not liable for any indirect, incidental, special, consequential, or punitive damages, or any loss of profits, revenue, data, or goodwill, arising out of or related to your use of the service. Our total liability for any claim is limited to the greater of (a) the amount of fees paid to us (if any) in the 30 days before the event giving rise to the claim, or (b) 0 sats.</div>

                  <div className="legalH">7. Assumption of risk</div>
                  <div className="legalP">You understand that Lightning payments may fail, be delayed, or be irreversible, and that network fees, routing, provider downtime, or other issues may affect deposits/withdrawals. You assume these risks.</div>

                  <div className="legalH">8. Indemnity</div>
                  <div className="legalP">You agree to indemnify and hold us harmless from claims, damages, liabilities, and expenses arising from your use of the service, your violation of these Terms, or your violation of any law or rights of a third party.</div>

                  <div className="legalH">9. Disputes; governing law; venue</div>
                  <div className="legalP">Governing law and venue depend on the operator’s jurisdiction: . If your jurisdiction restricts certain dispute terms (e.g., arbitration/class-action waivers), those restrictions apply.</div>

                  <div className="legalH">10. Termination</div>
                  <div className="legalP">We may suspend or terminate access to the service at any time. You remain responsible for any activity conducted via your wallet credentials.</div>

                  <div className="legalH">11. Changes</div>
                  <div className="legalP">We may update these Terms from time to time. Continued use after changes means you accept the updated Terms.</div>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
