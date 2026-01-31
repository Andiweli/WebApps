import { GigyaApi, KamereonApi } from '@remscodes/renault-api';

const TTL_MS = 25_000;
const DEFAULT_KAMEREON_ORIGIN = 'https://api-wired-prod-1-euw1.wrd-aws.com';

function asForm(bodyObj) {
  return new URLSearchParams(Object.entries(bodyObj).map(([k, v]) => [k, String(v)]));
}

function pick(obj, paths) {
  for (const p of paths) {
    const parts = p.split('.');
    let cur = obj;
    let ok = true;
    for (const part of parts) {
      if (cur && typeof cur === 'object' && part in cur) cur = cur[part];
      else { ok = false; break; }
    }
    if (ok && cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return null;
}

class HttpError extends Error {
  constructor(message, status, bodyText) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.bodyText = bodyText;
  }
}

export class RenaultService {
  constructor({ email, password, country, locale, vin, kamereonOrigin }) {
    if (!email || !password) throw new Error('Missing RENAULT_EMAIL or RENAULT_PASSWORD in .env');

    this.email = email;
    this.password = password;
    this.country = country || 'AT';
    this.locale = locale || 'de_AT';
    this.preferredVin = vin;

    this.kamereonOrigin = kamereonOrigin || process.env.RENAULT_KAMEREON_ORIGIN || DEFAULT_KAMEREON_ORIGIN;

    this.ctx = null; // { gigyaCookie, idToken, personId, accountId, vin }
    this.vehicleMeta = null;
    this.cache = { at: 0, data: null };

    this._reloginPromise = null;
  }

  // ---------- Gigya auth ----------

  async gigyaLogin() {
    const url = new URL(GigyaApi.LOGIN_URL);
    url.searchParams.set('apikey', GigyaApi.KEY);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: asForm({ loginID: this.email, password: this.password }),
    });

    const json = await res.json().catch(() => ({}));
    const cookieValue = pick(json, ['sessionInfo.cookieValue']);
    if (!cookieValue) {
      const msg =
        pick(json, ['errorMessage', 'errorDetails', 'error_description']) ||
        `Gigya login failed (HTTP ${res.status})`;
      const code = pick(json, ['errorCode']) || '';
      throw new Error(`Gigya login failed ${code ? `(code ${code}) ` : ''}: ${msg}`);
    }
    return cookieValue;
  }

  async gigyaGetAccountInfo(gigyaCookie) {
    const base = new URL(GigyaApi.LOGIN_URL);
    base.pathname = '/accounts.getAccountInfo';
    base.search = '';
    base.searchParams.set('apikey', GigyaApi.KEY);

    const res = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: asForm({ oauth_token: gigyaCookie, login_token: gigyaCookie }),
    });

    const json = await res.json().catch(() => ({}));
    const personId = pick(json, ['data.personId', 'data.personID']);
    if (!personId) {
      const msg = pick(json, ['errorMessage', 'errorDetails']) || 'Gigya getAccountInfo failed';
      throw new Error(msg);
    }
    return personId;
  }

  async gigyaGetJwt(gigyaCookie) {
    const base = new URL(GigyaApi.LOGIN_URL);
    base.pathname = '/accounts.getJWT';
    base.search = '';
    base.searchParams.set('apikey', GigyaApi.KEY);

    const res = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: asForm({
        oauth_token: gigyaCookie,
        login_token: gigyaCookie,
        fields: 'data.personId,data.gigyaDataCenter',
        expiration: 900,
      }),
    });

    const json = await res.json().catch(() => ({}));
    const idToken = pick(json, ['id_token', 'idToken']);
    if (!idToken) {
      const msg = pick(json, ['errorMessage', 'errorDetails']) || 'Gigya getJWT failed';
      throw new Error(msg);
    }
    return idToken;
  }

  // ---------- Relogin / 401 handling ----------

  _is401(err) {
    const status = err?.status || err?.response?.status;
    if (status === 401) return true;
    if (err?.name === 'HttpError' && err?.status === 401) return true;
    const msg = String(err?.message || err || '');
    return msg.includes('GET 401') || msg.includes('POST 401') || msg.includes('HTTP 401') || msg.includes(' 401');
  }

  _invalidateContext() {
    this.ctx = null;
    this.vehicleMeta = null;
    this.cache = { at: 0, data: null };
  }

  async _reloginLocked() {
    if (this._reloginPromise) return this._reloginPromise;

    this._reloginPromise = (async () => {
      this._invalidateContext();
      await this.ensureContext(true);
    })();

    try {
      return await this._reloginPromise;
    } finally {
      this._reloginPromise = null;
    }
  }

  // ---------- Kamereon helpers ----------

  kamereonHeaders(idToken) {
    return {
      accept: 'application/json',
      'content-type': 'application/vnd.api+json',
      apikey: KamereonApi.KEY,
      'x-gigya-id_token': idToken,
    };
  }

  withCountry(url) {
    const u = new URL(url);
    if (!u.searchParams.has('country')) u.searchParams.set('country', this.country);
    return u;
  }

  async kamereonGet(pathOrUrl, idToken) {
    const url = pathOrUrl.startsWith('http')
      ? new URL(pathOrUrl)
      : new URL(pathOrUrl, this.kamereonOrigin);

    const doFetch = async (tok) => {
      const res = await fetch(this.withCountry(url), { headers: this.kamereonHeaders(tok) });
      const text = await res.text();
      if (!res.ok) throw new HttpError(`Kamereon GET ${res.status}`, res.status, text);
      return text ? JSON.parse(text) : null;
    };

    try {
      return await doFetch(idToken);
    } catch (e) {
      if (!this._is401(e)) throw e;
      console.warn('[WARN] Kamereon GET 401 -> re-login + retry');
      await this._reloginLocked();
      const fresh = await this.ensureContext();
      return await doFetch(fresh.idToken);
    }
  }

  async kamereonPost(pathOrUrl, idToken, payload) {
    const url = pathOrUrl.startsWith('http')
      ? new URL(pathOrUrl)
      : new URL(pathOrUrl, this.kamereonOrigin);

    const doFetch = async (tok) => {
      const res = await fetch(this.withCountry(url), {
        method: 'POST',
        headers: this.kamereonHeaders(tok),
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      if (!res.ok) throw new HttpError(`Kamereon POST ${res.status}`, res.status, text);
      return text ? JSON.parse(text) : { ok: true };
    };

    try {
      return await doFetch(idToken);
    } catch (e) {
      if (!this._is401(e)) throw e;
      console.warn('[WARN] Kamereon POST 401 -> re-login + retry');
      await this._reloginLocked();
      const fresh = await this.ensureContext();
      return await doFetch(fresh.idToken);
    }
  }

  // ---------- Context bootstrap + Vehicle meta ----------

  _extractVehicleMetaFromLink(v) {
    const vd = v?.vehicleDetails || v?.attributes?.vehicleDetails || v?.data?.attributes?.vehicleDetails || {};
    const picture =
      vd?.pictureURL ||
      vd?.pictureUrl ||
      vd?.vehiclePictureUrl ||
      vd?.vehiclePictureURL ||
      v?.pictureURL ||
      v?.pictureUrl ||
      null;

    const model =
      vd?.modelName ||
      vd?.model ||
      vd?.commercialName ||
      v?.modelName ||
      null;

    const brand =
      vd?.brand ||
      vd?.make ||
      null;

    return {
      vin: v?.vin || vd?.vin || null,
      model: model,
      brand: brand,
      pictureUrl: picture,
      raw: {
        modelName: vd?.modelName || null,
        commercialName: vd?.commercialName || null
      }
    };
  }

  async ensureContext(force = false) {
    if (!force && this.ctx?.idToken && this.ctx?.accountId && this.ctx?.vin) return this.ctx;

    const gigyaCookie = await this.gigyaLogin();
    const personId = await this.gigyaGetAccountInfo(gigyaCookie);
    const idToken = await this.gigyaGetJwt(gigyaCookie);

    const person = await this.kamereonGet(`/commerce/v1/persons/${personId}`, idToken);
    const accounts = person?.accounts || person?.data?.attributes?.accounts || [];
    if (!accounts.length) throw new Error('No accounts found in Kamereon person response');

    const my = accounts.find(a => (a.accountType || a?.attributes?.accountType) === 'MYRENAULT') || accounts[0];
    const accountId = my.accountId || my?.attributes?.accountId;
    if (!accountId) throw new Error('Could not determine accountId');

    const vehicles = await this.kamereonGet(`/commerce/v1/accounts/${accountId}/vehicles`, idToken);
    const links = vehicles?.vehicleLinks || vehicles?.data?.vehicleLinks || vehicles?.data || [];
    const vins = links.map(v => v?.vin || v?.vehicleDetails?.vin || v?.attributes?.vin).filter(Boolean);

    if (!vins.length) throw new Error('No vehicles found for this account');

    const vin = (this.preferredVin && vins.includes(this.preferredVin)) ? this.preferredVin : vins[0];

    const selectedLink =
      links.find(v => (v?.vin || v?.vehicleDetails?.vin || v?.attributes?.vin) === vin) || links[0];

    this.vehicleMeta = this._extractVehicleMetaFromLink(selectedLink);
    this.vehicleMeta.vin = vin;

    this.ctx = { gigyaCookie, personId, idToken, accountId, vin };
    return this.ctx;
  }

  // ---------- Parsers ----------

  parseBattery(r) {
    const a = r?.data?.attributes || r?.data || {};

    const plugStatus = a.plugStatus ?? null;
    const chargingStatus = a.chargingStatus ?? null;
    const remainMin = a.chargingRemainingTime ?? null;
    const chargingPower = a.chargingInstantaneousPower ?? null;

    const plugStr = String(plugStatus ?? '').toLowerCase();
    const statusStr = String(chargingStatus ?? '').toLowerCase();

    const plugNum = (typeof plugStatus === 'number') ? plugStatus : Number(plugStatus);
    const statusNum = (typeof chargingStatus === 'number') ? chargingStatus : Number(chargingStatus);

    const powerNum = (typeof chargingPower === 'number') ? chargingPower : Number(chargingPower);
    const powerPositive = Number.isFinite(powerNum) && powerNum > 0;

    const isPlugged =
      plugNum === 1 ||
      plugStr === 'plugged' ||
      plugStr === 'connected' ||
      plugStr === 'true' ||
      plugStr === '1';

    const statusSaysCharging =
      statusStr.includes('charging') ||
      statusStr.includes('in_progress') ||
      statusStr.includes('progress');

    // ✅ WICHTIG: Numeric codes nur sehr konservativ interpretieren.
    // Bei dir ist "laden" = 1, "nicht laden" = 0, und Werte wie 0.3 kommen vor.
    // 0.3 behandeln wir NICHT als "lädt".
    const statusNumSaysCharging =
      Number.isFinite(statusNum) ? (statusNum >= 0.9) : false; // 1.0 => charging, 0.0 => not charging, 0.3 => NOT charging

    // ✅ NEU: Restzeit NICHT als Beweis verwenden (hängt oft nach)
    const isCharging = powerPositive || statusSaysCharging || statusNumSaysCharging;

    return {
      batteryLevel: a.batteryLevel ?? null,
      batteryAutonomyKm: a.batteryAutonomy ?? null,
      plugStatus,
      chargingStatus,
      chargingRemainingTimeMin: remainMin ?? null,
      chargingInstantaneousPower: chargingPower ?? null,

      isPlugged,
      isCharging,

      timestamp: a.timestamp || a.lastUpdateTime || null
    };
  }

  parseCockpit(r) {
    const a = r?.data?.attributes || r?.data || {};
    return {
      totalMileageKm: a.totalMileage ?? a.totalMileageKm ?? null,
      fuelAutonomyKm: a.fuelAutonomy ?? null,
      timestamp: a.timestamp || a.lastUpdateTime || null
    };
  }

  parseHvac(r) {
    const a = r?.data?.attributes || r?.data || {};
    return {
      hvacStatus: a.hvacStatus ?? a.status ?? null,
      externalTemperature: a.externalTemperature ?? null,
      internalTemperature: a.internalTemperature ?? null,
      lastUpdateTime: a.lastUpdateTime || a.timestamp || null
    };
  }

  parseLocation(r) {
    const a = r?.data?.attributes || r?.data || {};
    return {
      latitude: a.gpsLatitude ?? a.latitude ?? a.lat ?? null,
      longitude: a.gpsLongitude ?? a.longitude ?? a.lng ?? null,
      heading: a.heading ?? null,
      timestamp: a.timestamp || a.lastUpdateTime || null
    };
  }

  // ---------- Summary ----------

  async getSummary() {
    const now = Date.now();
    if (this.cache.data && (now - this.cache.at) < TTL_MS) return this.cache.data;

    const { idToken, accountId, vin } = await this.ensureContext();

    const batteryUrl = KamereonApi.READ_BATTERY_STATUS_URL(accountId, vin);
    const cockpitPath = `/commerce/v1/accounts/${accountId}/kamereon/kca/car-adapter/v1/cars/${vin}/cockpit`;
    const hvacPath = `/commerce/v1/accounts/${accountId}/kamereon/kca/car-adapter/v1/cars/${vin}/hvac-status`;
    const locationPath = `/commerce/v1/accounts/${accountId}/kamereon/kca/car-adapter/v1/cars/${vin}/location`;

    const [battery, cockpit, hvac, location] = await Promise.allSettled([
      this.kamereonGet(batteryUrl, idToken),
      this.kamereonGet(cockpitPath, idToken),
      this.kamereonGet(hvacPath, idToken),
      this.kamereonGet(locationPath, idToken),
    ]);

    const batteryErr = battery.status === 'rejected' ? battery.reason : null;
    const cockpitErr = cockpit.status === 'rejected' ? cockpit.reason : null;
    const hvacErr = hvac.status === 'rejected' ? hvac.reason : null;
    const locationErr = location.status === 'rejected' ? location.reason : null;

    const has401 =
      this._is401(batteryErr) ||
      this._is401(cockpitErr) ||
      this._is401(hvacErr) ||
      this._is401(locationErr);

    const data = {
      vehicle: {
        vin,
        model: this.vehicleMeta?.model || null,
        brand: this.vehicleMeta?.brand || null,
        pictureUrl: this.vehicleMeta?.pictureUrl || null,
      },
      battery: battery.status === 'fulfilled' ? this.parseBattery(battery.value) : { error: String(batteryErr?.message || batteryErr) },
      cockpit: cockpit.status === 'fulfilled' ? this.parseCockpit(cockpit.value) : { error: String(cockpitErr?.message || cockpitErr) },
      hvac: hvac.status === 'fulfilled' ? this.parseHvac(hvac.value) : { error: String(hvacErr?.message || hvacErr) },
      location: location.status === 'fulfilled' ? this.parseLocation(location.value) : { error: String(locationErr?.message || locationErr) },
    };

    if (!has401) {
      this.cache = { at: now, data };
    } else {
      this.cache = { at: 0, data: null };
    }

    return data;
  }

  // ---------- Actions ----------

  async startHvac({ temperature }) {
    const { idToken, accountId, vin } = await this.ensureContext();
    const path = `/commerce/v1/accounts/${accountId}/kamereon/kca/car-adapter/v1/cars/${vin}/actions/hvac-start`;
    const payload = { data: { type: 'HvacStart', attributes: { action: 'start', targetTemperature: temperature } } };
    const out = await this.kamereonPost(path, idToken, payload);
    this.cache = { at: 0, data: null };
    return out;
  }

  async stopHvac() {
    const { idToken, accountId, vin } = await this.ensureContext();
    const path = `/commerce/v1/accounts/${accountId}/kamereon/kca/car-adapter/v1/cars/${vin}/actions/hvac-start`;
    const payload = { data: { type: 'HvacStart', attributes: { action: 'cancel' } } };
    const out = await this.kamereonPost(path, idToken, payload);
    this.cache = { at: 0, data: null };
    return out;
  }
}
