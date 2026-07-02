const https = require('https');
const crypto = require('crypto');

const API_BASE = 'https://apiv2.tradersaham.com/api';
const SECRET = process.env.TRS_SECRET || 'trs_idx_v2_2024';
const BROKER_NAMES = {
  BB: 'Verdhana', BK: 'JP Morgan', CC: 'Mandiri Sekuritas',
  AK: 'UBS Sekuritas', AZ: 'Sucor', LG: 'Trimegah', XL: 'Stockbit',
  NI: 'BNI Sekuritas', ZP: 'Maybank', OD: 'BRI', DX: 'Bahana',
  YU: 'Trimegah', TP: 'OCBC',
};

function makeSig(path, ts) {
  const raw = path.slice(-4) + ts + SECRET;
  return Buffer.from(raw).toString('base64').slice(5, 21);
}

function apiGet(path, params = {}) {
  return new Promise((resolve, reject) => {
    const ts = String(Date.now());
    const sig = makeSig(path, ts);
    params._t = ts;
    const qs = new URLSearchParams(params).toString();
    const url = `${API_BASE}${path}?${qs}`;
    const opts = {
      headers: {
        Accept: 'application/json',
        Origin: 'https://www.tradersaham.com',
        Referer: 'https://www.tradersaham.com/broker-flow',
        'X-RQ-T': ts,
        'X-RQ-S': sig,
      },
      timeout: 15000,
    };
    https.get(url, opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    }).on('error', reject);
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { brokers = 'BB,BK,CC', date, minVal = '0' } = req.query;
    const brList = brokers.split(',').map((b) => b.trim().toUpperCase()).filter(Boolean);
    const minValue = parseInt(minVal) || 0;

    const ff = await apiGet('/market-insight/foreign-flow');
    if (!ff) return res.status(500).json({ error: 'Failed to get foreign flow' });

    const ffDate = ff.date.slice(0, 10);
    const dateStr = date || ffDate;
    const stocks = {};
    for (const s of [...(ff.accumulation || []), ...(ff.distribution || [])]) {
      stocks[s.stock_code] = {
        close: s.close_price || 0,
        stock_name: s.stock_name || '',
        net_value: parseInt(s.net_value) || 0,
      };
    }
    const codes = Object.keys(stocks);
    const brokerMap = {};
    brList.forEach((b) => (brokerMap[b] = {}));

    // Scan in batches — 5 concurrent
    const batchSize = 5;
    for (let i = 0; i < codes.length; i += batchSize) {
      const batch = codes.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map((code) =>
          apiGet('/analytics/broksum', {
            stock_code: code,
            start_date: dateStr,
            end_date: dateStr,
          }).then((data) => ({ code, data }))
        )
      );
      for (const { code, data } of results) {
        if (!data || !data.tape) continue;
        for (const t of data.tape) {
          if (!brList.includes(t.broker_code)) continue;
          const bc = t.broker_code;
          const tv = parseInt(t.total_value) || 0;
          if (tv < minValue) continue;
          brokerMap[bc][code] = {
            stock: code,
            name: stocks[code]?.stock_name || '',
            close: stocks[code]?.close || 0,
            status: t.status,
            type: t.broker_type,
            net_lot: parseInt(t.net_lot) || 0,
            net_value: parseInt(t.net_value) || 0,
            total_lot: parseInt(t.total_lot) || 0,
            total_value: tv,
            avg_buy: parseInt(t.avg_buy_price) || 0,
            avg_sell: parseInt(t.avg_sell_price) || 0,
          };
        }
      }
    }

    const result = { date: dateStr, all_stocks: codes.length, brokers: {} };
    for (const bc of brList) {
      result.brokers[bc] = Object.values(brokerMap[bc]).sort(
        (a, b) => b.total_value - a.total_value
      );
    }

    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
