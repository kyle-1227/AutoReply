import { $ } from "./ui.js";

export function initializeGenerationSettings({ request, notify }) {
  let settings;
  $("open-settings").addEventListener("click", async () => {
    try {
      ({ settings } = await request("SETTINGS", { action: "GET" }));
      $("generation-key").value = "";
      $("generation-key").placeholder = settings.hasApiKey ? "已保存在本机，留空保持原值" : "输入 API Key";
      $("clear-key").checked = false;
      $("text-model").value = settings.model;
      $("video-model").value = settings.videoModel;
      $("prompt-id").value = settings.prompt.id;
      $("prompt-version").value = settings.prompt.version;
      $("prompt-text").value = settings.prompt.text;
      $("structured-outputs").checked = settings.structuredOutputs;
      $("settings-error").hidden = true;
      $("settings-dialog").showModal();
    } catch (error) { notify(error.message); }
  });
  $("settings-form").addEventListener("submit", async event => {
    event.preventDefault();
    const button = $("save-settings");
    if (button.disabled) return;
    button.disabled = true;
    const prompt = { id: $("prompt-id").value.trim(), version: $("prompt-version").value.trim(), text: $("prompt-text").value.trim() };
    try {
      await request("SETTINGS", { action: "SAVE", payload: {
        previousRevision: settings.revision || 0,
        apiKey: $("generation-key").value, clearKey: $("clear-key").checked,
        model: $("text-model").value.trim(), videoModel: $("video-model").value.trim(),
        prompt, structuredOutputs: $("structured-outputs").checked,
      } });
      $("settings-dialog").close();
      notify("生成设置已保存在本机，下一次生成时使用。");
    } catch (error) {
      $("settings-error").hidden = false;
      $("settings-error").textContent = error.message;
    } finally { button.disabled = false; }
  });
  $("settings-dialog").addEventListener("close", () => { $("generation-key").value = ""; });
}
