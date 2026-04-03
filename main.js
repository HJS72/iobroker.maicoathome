"use strict";

const utils = require("@iobroker/adapter-core");

const Q_DEVICE_GROUPS = `
{
  me {
    deviceGroups {
      uuid
      name
      defaultGroup
      devices {
        uuid
        name
        serialNumber
        deviceType
        articleNumber
        lastSync
      }
    }
  }
}
`;

const Q_DEVICE_STATE = `
query DeviceState($uuid: String!) {
  deviceState(deviceUuid: $uuid) {
    device { uuid name deviceType lastSync }
    state
    error
  }
}
`;

const Q_DEVICE_TELEMETRY = `
query DeviceTelemetry($uuid: String!) {
  deviceTelemetry(deviceUuid: $uuid) {
    telemetry
    updatedAt
    online
    error
  }
}
`;

const M_SET_PARAM = `
mutation SetParam($uuid: String!, $param: Int!, $value: String!) {
  setDeviceParameter(deviceUuid: $uuid, parameterNumber: $param, value: $value) {
    success
    error
  }
}
`;

const M_REQUEST_DATA = `
mutation RequestData($uuid: String!) {
  requestDeviceData(deviceUuid: $uuid)
}
`;

const STATUS_STATES = {
  operating_mode: { type: "number", role: "value", name: "Betriebsart" },
  fan_level_current: { type: "number", role: "value", name: "Lueftungsstufe" },
  room_temperature: { type: "number", role: "value.temperature", unit: "degC", name: "Temp Raum" },
  inlet_air_temperature: { type: "number", role: "value.temperature", unit: "degC", name: "Temp Lufteintritt" },
  target_room_temperature: { type: "number", role: "value.temperature", unit: "degC", name: "Solltemperatur" },
  supply_air_temperature: { type: "number", role: "value.temperature", unit: "degC", name: "Temp Zuluft" },
  extract_air_temperature: { type: "number", role: "value.temperature", unit: "degC", name: "Temp Abluft" },
  exhaust_air_temperature: { type: "number", role: "value.temperature", unit: "degC", name: "Temp Fortluft" },
  extract_air_humidity: { type: "number", role: "value.humidity", unit: "%", name: "Feuchte Abluft" },
  humidity_min: { type: "number", role: "value.humidity", unit: "%", name: "Feuchte Min" },
  humidity_max: { type: "number", role: "value.humidity", unit: "%", name: "Feuchte Max" },
  device_filter_remaining: { type: "number", role: "value", unit: "days", name: "Geraetefilter Rest" },
  outside_filter_remaining: { type: "number", role: "value", unit: "days", name: "Aussenfilter Rest" },
  room_filter_remaining: { type: "number", role: "value", unit: "days", name: "Raumfilter Rest" },
  device_filter_interval: { type: "number", role: "value", unit: "months", name: "Geraetefilter Intervall" },
  outside_filter_interval: { type: "number", role: "value", unit: "months", name: "Aussenfilter Intervall" },
  room_filter_interval: { type: "number", role: "value", unit: "months", name: "Raumfilter Intervall" },
  online: { type: "boolean", role: "indicator.connected", name: "Online" },
  updated_at: { type: "string", role: "text", name: "Telemetry Updated At" },
  cloud_error: { type: "string", role: "text", name: "Cloud Fehler" }
};

const REMOTE_STATES = {
  operating_mode: { type: "number", role: "level", name: "Betriebsart", min: 0, max: 5 },
  fan_level: { type: "number", role: "level", name: "Lueftungsstufe", min: 0, max: 4 },
  target_room_temperature: {
    type: "number",
    role: "level.temperature",
    unit: "degC",
    name: "Solltemperatur",
    min: 10,
    max: 35
  },
  device_filter_changed: { type: "boolean", role: "button", name: "Geraetefilter gewechselt" },
  outside_filter_changed: { type: "boolean", role: "button", name: "Aussenfilter gewechselt" },
  room_filter_changed: { type: "boolean", role: "button", name: "Raumfilter gewechselt" }
};

const CLOUD_PARAM_MAP = {
  operating_mode: 530,
  fan_level: 105,
  target_room_temperature: 610,
  device_filter_changed: 157,
  outside_filter_changed: 158,
  room_filter_changed: 159
};

const MODE_TO_P530 = { 0: 0, 1: 1, 2: 2, 3: 2, 4: 3, 5: 4 };

function normalizeName(name) {
  const basic = String(name || "device")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return basic || "device";
}

class MaicoAtHome extends utils.Adapter {
  constructor(options = {}) {
    super({ ...options, name: "maicoathome" });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));

    this.token = null;
    this.deviceBySlug = new Map();
    this.pollTimer = null;
  }

  async onReady() {
    if (!this.config.username || !this.config.password) {
      this.log.error("Bitte E-Mail und Passwort konfigurieren.");
      return;
    }

    if (this.config.verifySsl === false) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      this.log.warn("SSL verification is disabled.");
    }

    await this.setStateAsync("info.connection", false, true);

    await this.login();
    const devices = await this.listDevices();
    if (!devices.length) {
      this.log.warn("Keine Geraete im Account gefunden.");
      return;
    }

    await this.ensureObjects(devices);
    await this.subscribeStatesAsync("*.Remote.*");

    await this.pollAllDevices();
    const intervalMs = Math.max(3, Number(this.config.pollIntervalSec || 10)) * 1000;
    this.pollTimer = setInterval(() => {
      this.pollAllDevices().catch((err) => this.log.warn(`Polling failed: ${err.message || err}`));
    }, intervalMs);

    await this.setStateAsync("info.connection", true, true);
    this.log.info(`Adapter started. Devices: ${devices.length}`);
  }

  async onUnload(callback) {
    try {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      callback();
    } catch {
      callback();
    }
  }

  async onStateChange(id, state) {
    if (!state || state.ack) {
      return;
    }

    const local = id.replace(`${this.namespace}.`, "");
    const parts = local.split(".");
    if (parts.length < 3) {
      return;
    }

    const [deviceSlug, branch, datapoint] = parts;
    if (branch !== "Remote") {
      return;
    }

    const device = this.deviceBySlug.get(deviceSlug);
    if (!device) {
      this.log.warn(`Unknown device slug for state change: ${deviceSlug}`);
      return;
    }

    try {
      await this.writeRemote(device.uuid, datapoint, state.val);
      await this.setStateAsync(local, { val: state.val, ack: true });
      await this.requestDeviceData(device.uuid);
      await this.pollDevice(device);
    } catch (err) {
      this.log.error(`Write failed for ${local}: ${err.message || err}`);
    }
  }

  async login() {
    const tokenUrl = String(this.config.authUrl || "").trim();
    const ids = String(this.config.oidcClientIds || "airhome-app,myaccount")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    let lastErr = null;
    for (const clientId of ids) {
      try {
        const body = new URLSearchParams({
          grant_type: "password",
          client_id: clientId,
          username: this.config.username,
          password: this.config.password,
          scope: "openid profile email customerType"
        });

        const res = await fetch(tokenUrl, {
          method: "POST",
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body
        });

        const json = await res.json();
        if (json && json.access_token) {
          this.token = json.access_token;
          this.log.debug(`OIDC login successful via client_id=${clientId}`);
          return;
        }
        lastErr = new Error(`No access_token for client_id=${clientId}`);
      } catch (err) {
        lastErr = err;
      }
    }

    throw new Error(`OIDC login failed: ${lastErr ? lastErr.message || lastErr : "unknown"}`);
  }

  async graphql(query, variables) {
    if (!this.token) {
      await this.login();
    }

    const res = await fetch(String(this.config.baseUrl || "").trim(), {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "App-Version": String(this.config.appVersion || "1.4.4"),
        "Authorization": `Bearer ${this.token}`
      },
      body: JSON.stringify({ query, variables })
    });

    const json = await res.json();

    if (json && Array.isArray(json.errors) && json.errors.length) {
      const msg = json.errors.map((e) => e.message || String(e)).join("; ");
      throw new Error(msg);
    }

    return json;
  }

  async listDevices() {
    const res = await this.graphql(Q_DEVICE_GROUPS, undefined);
    const groups = (((res || {}).data || {}).me || {}).deviceGroups || [];

    const byUuid = new Map();
    for (const g of groups) {
      for (const d of g.devices || []) {
        byUuid.set(d.uuid, d);
      }
    }

    const devices = [...byUuid.values()].map((d) => ({
      uuid: String(d.uuid),
      name: String(d.name || d.uuid),
      serialNumber: String(d.serialNumber || ""),
      deviceType: String(d.deviceType || "")
    }));

    this.deviceBySlug.clear();
    for (const d of devices) {
      let slug = normalizeName(d.name);
      if (this.deviceBySlug.has(slug)) {
        slug = `${slug}_${d.uuid.slice(0, 6)}`;
      }
      d.slug = slug;
      this.deviceBySlug.set(slug, d);
    }

    return devices;
  }

  async ensureObjects(devices) {
    for (const d of devices) {
      await this.setObjectNotExistsAsync(d.slug, {
        type: "device",
        common: {
          name: d.name
        },
        native: {
          uuid: d.uuid,
          serialNumber: d.serialNumber,
          deviceType: d.deviceType
        }
      });

      await this.setObjectNotExistsAsync(`${d.slug}.Status`, {
        type: "channel",
        common: { name: "Status" },
        native: {}
      });

      await this.setObjectNotExistsAsync(`${d.slug}.Remote`, {
        type: "channel",
        common: { name: "Remote" },
        native: {}
      });

      for (const [id, meta] of Object.entries(STATUS_STATES)) {
        await this.setObjectNotExistsAsync(`${d.slug}.Status.${id}`, {
          type: "state",
          common: {
            name: meta.name,
            type: meta.type,
            role: meta.role,
            read: true,
            write: false,
            unit: meta.unit
          },
          native: {}
        });
      }

      for (const [id, meta] of Object.entries(REMOTE_STATES)) {
        await this.setObjectNotExistsAsync(`${d.slug}.Remote.${id}`, {
          type: "state",
          common: {
            name: meta.name,
            type: meta.type,
            role: meta.role,
            read: true,
            write: true,
            unit: meta.unit,
            min: meta.min,
            max: meta.max
          },
          native: {}
        });
      }
    }
  }

  async pollAllDevices() {
    for (const d of this.deviceBySlug.values()) {
      await this.pollDevice(d);
    }
  }

  async pollDevice(device) {
    const [stateRes, teleRes] = await Promise.all([
      this.graphql(Q_DEVICE_STATE, { uuid: device.uuid }),
      this.graphql(Q_DEVICE_TELEMETRY, { uuid: device.uuid })
    ]);

    const deviceState = (((stateRes || {}).data || {}).deviceState) || {};
    const rawState = safeJsonParse(deviceState.state, {});

    const telemetryNode = (((teleRes || {}).data || {}).deviceTelemetry) || {};
    const telemetry = safeJsonParse(telemetryNode.telemetry, {});

    const status = mapStatus(rawState, telemetry);
    status.online = Boolean(telemetryNode.online);
    status.updated_at = telemetryNode.updatedAt ? String(telemetryNode.updatedAt) : "";
    status.cloud_error = telemetryNode.error ? String(telemetryNode.error) : "";

    for (const key of Object.keys(STATUS_STATES)) {
      const v = status[key];
      if (
        v !== undefined &&
        v !== null &&
        (Number.isFinite(v) || typeof v === "string" || typeof v === "boolean")
      ) {
        await this.setStateChangedAsync(`${device.slug}.Status.${key}`, { val: v, ack: true });
      }
    }

    // Mirror selected status values to Remote as defaults for easy control.
    if (status.operating_mode !== undefined) {
      await this.setStateChangedAsync(`${device.slug}.Remote.operating_mode`, { val: status.operating_mode, ack: true });
    }
    if (status.fan_level_current !== undefined) {
      await this.setStateChangedAsync(`${device.slug}.Remote.fan_level`, { val: status.fan_level_current, ack: true });
    }
    if (status.target_room_temperature !== undefined) {
      await this.setStateChangedAsync(`${device.slug}.Remote.target_room_temperature`, {
        val: status.target_room_temperature,
        ack: true
      });
    }
  }

  async writeRemote(deviceUuid, key, rawValue) {
    const param = CLOUD_PARAM_MAP[key];
    if (!param) {
      throw new Error(`Remote datapoint not writable: ${key}`);
    }

    let valueToSend;
    if (key === "operating_mode") {
      const mode = Number(rawValue);
      valueToSend = MODE_TO_P530[mode] !== undefined ? MODE_TO_P530[mode] : mode;
    } else if (key === "target_room_temperature") {
      valueToSend = String(Number(rawValue));
    } else if (key.endsWith("_changed")) {
      valueToSend = rawValue === true || rawValue === 1 || rawValue === "1" ? 1 : 0;
    } else {
      valueToSend = Number(rawValue);
    }

    const res = await this.graphql(M_SET_PARAM, {
      uuid: deviceUuid,
      param,
      value: String(valueToSend)
    });

    const result = (((res || {}).data || {}).setDeviceParameter) || {};
    if (result.error) {
      throw new Error(`setDeviceParameter error: ${result.error}`);
    }
    if (result.success === false) {
      throw new Error("setDeviceParameter returned success=false");
    }
  }

  async requestDeviceData(deviceUuid) {
    try {
      await this.graphql(M_REQUEST_DATA, { uuid: deviceUuid });
    } catch (err) {
      this.log.debug(`requestDeviceData failed: ${err.message || err}`);
    }
  }
}

function safeJsonParse(text, fallback) {
  if (!text || typeof text !== "string") {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function mapStatus(params, telemetry) {
  const out = {};

  // state map
  out.target_room_temperature = num(params.p610);
  out.humidity_min = intNum(params.p647);
  out.humidity_max = intNum(params.p648);
  out.device_filter_interval = intNum(params.p150);
  out.outside_filter_interval = intNum(params.p151);
  out.room_filter_interval = intNum(params.p152);

  if (params.p500 !== undefined && params.p500 !== null && params.p500 !== "") {
    out.operating_mode = intNum(params.p500);
  } else if (params.p530 !== undefined && params.p530 !== null && params.p530 !== "") {
    const mode530 = intNum(params.p530);
    const modeMap = { 0: 0, 1: 1, 2: 2, 3: 4, 4: 5 };
    if (modeMap[mode530] !== undefined) {
      out.operating_mode = modeMap[mode530];
    }
  }

  if (params.p105 !== undefined && params.p105 !== null && params.p105 !== "") {
    out.fan_level_current = intNum(params.p105);
  }

  // telemetry-first values
  if (telemetry && typeof telemetry === "object") {
    setNum(out, "supply_air_temperature", telemetry.p600, 10);
    setNum(out, "extract_air_temperature", telemetry.p601, 1);
    setNum(out, "exhaust_air_temperature", telemetry.p602, 1);
    setNum(out, "inlet_air_temperature", telemetry.p603, 1);
    setNum(out, "extract_air_humidity", telemetry.p617, 1);
    setNum(out, "room_temperature", telemetry.p601, 1);

    if (telemetry.p104 !== undefined && telemetry.p104 !== null && telemetry.p104 !== "") {
      out.fan_level_current = intNum(telemetry.p104);
    }

    out.device_filter_remaining = intNum(telemetry.p707);
    out.outside_filter_remaining = intNum(telemetry.p708);
    out.room_filter_remaining = intNum(telemetry.p709);
  }

  return out;
}

function num(v) {
  if (v === undefined || v === null || v === "") {
    return undefined;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function intNum(v) {
  const n = num(v);
  return n === undefined ? undefined : Math.trunc(n);
}

function setNum(out, key, value, scale) {
  const n = num(value);
  if (n !== undefined) {
    out[key] = n / scale;
  }
}

if (require.main !== module) {
  module.exports = (options) => new MaicoAtHome(options);
} else {
  (() => new MaicoAtHome())();
}
