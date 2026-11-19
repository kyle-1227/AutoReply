export const UPDATE_VERSION = 1;
export const UPDATE_FILE = ".autoreply-update.json";
export const UPDATE_STATE_KEY = "autoreply.update.v1";
export const UPDATE_CLIENT_KEY = "autoreply.update-client.v1";
export const UPDATE_FIELDS = Object.freeze({
  update_probe: [], update_register: ["nonce", "clientVersion", "clientId"],
  update_check: ["clientVersion"], update_start: ["version"], update_status: [],
  update_ready: ["jobId", "prepareToken", "ok"], update_confirm: ["jobId"],
  update_settings: ["port", "token"], update_test: [],
});
export const finishedUpdate = phase => ["completed", "failed", "rolled_back", "restart_failed"].includes(phase);
