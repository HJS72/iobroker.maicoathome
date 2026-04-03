/**
 * ioBroker adapter for MAICO@HOME cloud devices.
 *
 * The adapter authenticates against the vendor OIDC endpoint, reads device
 * state and telemetry via GraphQL, and exposes each device as Status/Remote
 * channels inside the ioBroker object tree.
 */
"use strict";

const utils = require("@iobroker/adapter-core");

// GraphQL query: fetch all devices visible to the authenticated account.
const Q_DEVICE_GROUPS = `
{
  me {
    deviceGroups {
      uuid
      name
      devices {
        uuid
        name
        serialNumber
        deviceType
      }
    }
  }
}
`;

// GraphQL query: fetch the current parameter snapshot for a single device.
const Q_DEVICE_STATE = `
query DeviceState($uuid: String!) {
  deviceState(deviceUuid: $uuid) {
    state
  }
}
`;

// GraphQL query: fetch live telemetry values for a single device.
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

// GraphQL mutation: write a single device parameter identified by its numeric ID.
const M_SET_PARAM = `
mutation SetParam($uuid: String!, $param: Int!, $value: String!) {
  setDeviceParameter(deviceUuid: $uuid, parameterNumber: $param, value: $value) {
    success
    error
  }
}
`;

// GraphQL mutation: ask the cloud to trigger a fresh sync with the physical device.
const M_REQUEST_DATA = `
mutation RequestData($uuid: String!) {
  requestDeviceData(deviceUuid: $uuid)
}
`;

// Read-only ioBroker states populated from cloud state + telemetry.
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

// Writable ioBroker states mapped to cloud parameter writes.
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

// Maps writable ioBroker states to the cloud parameter numbers used by MAICO.
const CLOUD_PARAM_MAP = {
  operating_mode: 530,
  fan_level: 105,
  target_room_temperature: 610,
  device_filter_changed: 157,
  outside_filter_changed: 158,
  room_filter_changed: 159
};

// Operating mode writes use the p530 encoding, which differs from the exposed UI values.
const MODE_TO_P530 = { 0: 0, 1: 1, 2: 2, 3: 2, 4: 3, 5: 4 };

/**
 * Converts a device name into a stable ioBroker-friendly slug.
 * @param {string} name Device name from the cloud API
 * @returns {string} Lowercase slug containing only a-z, 0-9 and underscores
 */
function normalizeName(name) {
  const basic = String(name || "device")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return basic || "device";
}

/**
 * Main adapter class.
 */
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

  /**
   * Adapter startup hook: validate config, authenticate, discover devices,
   * create objects, subscribe to writable states, and start polling.
   */
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

  /**
   * Adapter shutdown hook: stop periodic polling.
   * @param {() => void} callback Completion callback required by ioBroker
   */
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

  /**
   * Handles writes to <device>.Remote.* states and forwards them to the cloud API.
   * @param {string} id Full ioBroker state ID
   * @param {ioBroker.State | null | undefined} state New state payload
   */
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

  /**
   * Logs in against the MAICO OIDC endpoint and caches the returned bearer token.
   * Multiple client IDs are tried because different app variants use different IDs.
   */
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

  /**
   * Sends one GraphQL request to the MAICO cloud API.
   * @param {string} query GraphQL query or mutation
   * @param {object | undefined} variables GraphQL variables
   * @returns {Promise<object>} Parsed JSON response
   */
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

  /**
   * Loads all visible devices, deduplicates them by UUID, and assigns a unique slug.
   * @returns {Promise<Array<{uuid: string, name: string, serialNumber: string, deviceType: string, slug: string}>>}
   */
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

  /**
   * Creates the ioBroker device/channel/state tree for all discovered devices.
   * @param {Array<{uuid: string, name: string, serialNumber: string, deviceType: string, slug: string}>} devices
   */
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

  /**
   * Polls all known devices sequentially.
   */
  async pollAllDevices() {
    for (const d of this.deviceBySlug.values()) {
      await this.pollDevice(d);
    }
  }

  /**
   * Fetches state and telemetry for one device, normalizes the result, and updates
   * the ioBroker Status states. Selected values are mirrored into Remote states so
   * the current device values are visible before the user writes new ones.
   * @param {{uuid: string, slug: string}} device Device descriptor
   */
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

  /**
   * Converts a writable ioBroker value into the format expected by the cloud API
   * and sends the setDeviceParameter mutation.
   * @param {string} deviceUuid Device UUID in the cloud API
   * @param {string} key Writable ioBroker state key
   * @param {*} rawValue Raw user-provided value
   */
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

  /**
   * Requests a fresh cloud/device sync after a successful write.
   * Errors are intentionally non-fatal because the next polling cycle can still recover.
   * @param {string} deviceUuid Device UUID in the cloud API
   */
  async requestDeviceData(deviceUuid) {
    try {
      await this.graphql(M_REQUEST_DATA, { uuid: deviceUuid });
    } catch (err) {
      this.log.debug(`requestDeviceData failed: ${err.message || err}`);
    }
  }
}

/**
 * Parses a JSON string and returns a fallback value on failure.
 * @param {string | undefined | null} text Raw JSON string
 * @param {*} fallback Value returned when parsing fails
 * @returns {*}
 */
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

/**
 * Normalizes raw MAICO state and telemetry parameter maps into the flat status
 * structure expected by STATUS_STATES.
 *
 * Parameter notes:
 * - p500 is the preferred operating-mode source when available.
 * - p530 uses a different encoding and is only used as fallback.
 * - p600 is fixed-point with one decimal place and therefore divided by 10.
 * - p104 telemetry overrides p105 from the slower state snapshot.
 *
 * @param {Record<string, *>} params Parsed deviceState.state payload
 * @param {Record<string, *>} telemetry Parsed deviceTelemetry.telemetry payload
 * @returns {Record<string, string | number | boolean | undefined>}
 */
function mapStatus(params, telemetry) {
  const out = {};

  // Snapshot values from the cloud state payload.
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

  // Current fan level from the state snapshot, possibly overwritten by telemetry below.
  if (params.p105 !== undefined && params.p105 !== null && params.p105 !== "") {
    out.fan_level_current = intNum(params.p105);
  }

  // Live telemetry values take precedence where they are more current.
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

/**
 * Converts a raw value to a finite number.
 * @param {*} v Raw input value
 * @returns {number | undefined}
 */
function num(v) {
  if (v === undefined || v === null || v === "") {
    return undefined;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Converts a raw value to a truncated integer.
 * @param {*} v Raw input value
 * @returns {number | undefined}
 */
function intNum(v) {
  const n = num(v);
  return n === undefined ? undefined : Math.trunc(n);
}

/**
 * Writes a scaled numeric value into the result object.
 * @param {Record<string, *>} out Target object
 * @param {string} key Property name in the target object
 * @param {*} value Raw input value
 * @param {number} scale Divisor applied to the parsed numeric value
 */
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
