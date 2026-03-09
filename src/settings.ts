/**
 * settings.ts — Obsidian SettingTab for Vault Mind configuration
 *
 * All settings are saved via plugin.saveSettings() which persists to
 * .obsidian/plugins/vault-mind/data.json (standard Obsidian pattern).
 */

import { App, PluginSettingTab, Setting, ButtonComponent } from "obsidian";
import type VaultMindPlugin from "./main";
import { OllamaEmbedder } from "./embedder";

export class VaultMindSettingsTab extends PluginSettingTab {
  plugin: VaultMindPlugin;

  constructor(app: App, plugin: VaultMindPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("General").setHeading();

    // --- Ollama connection ---
    new Setting(containerEl).setName("Ollama connection").setHeading();

    new Setting(containerEl)
      .setName("Ollama endpoint")
      .setDesc(
        "URL of your local Ollama server. Default: http://localhost:11434. " +
        "Change this only if you run Ollama on a custom port or remote host."
      )
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:11434")
          .setValue(this.plugin.settings.ollamaEndpoint)
          .onChange(async (value) => {
            this.plugin.settings.ollamaEndpoint = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Embedding model")
      .setDesc(
        "Ollama model to use for embeddings. Recommended: nomic-embed-text (768 dims, fast). " +
        "You must run `ollama pull <model>` before use."
      )
      .addText((text) =>
        text
          .setPlaceholder("nomic-embed-text")
          .setValue(this.plugin.settings.embeddingModel)
          .onChange(async (value) => {
            this.plugin.settings.embeddingModel = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // Connection test button
    let testResultEl: HTMLElement;
    const testSetting = new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Verify Ollama is running and the embedding model is available.");

    testResultEl = testSetting.settingEl.createDiv({ cls: "vault-mind-test-result" });

    testSetting.addButton((btn: ButtonComponent) =>
      btn
        .setButtonText("Test")
        .setCta()
        .onClick(async () => {
          testResultEl.setText("Checking...");
          testResultEl.removeClass("vault-mind-ok", "vault-mind-error");
          btn.setDisabled(true);

          try {
            const checker = new OllamaEmbedder(
              this.plugin.settings.ollamaEndpoint,
              this.plugin.settings.embeddingModel
            );
            const result = await checker.healthCheck();

            if (result.ok) {
              testResultEl.setText("Connected. Model is available.");
              testResultEl.addClass("vault-mind-ok");
            } else {
              testResultEl.setText(result.reason ?? "Unknown error");
              testResultEl.addClass("vault-mind-error");
            }
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            testResultEl.setText(msg);
            testResultEl.addClass("vault-mind-error");
          } finally {
            btn.setDisabled(false);
          }
        })
    );

    // --- Search behavior ---
    new Setting(containerEl).setName("Search behavior").setHeading();

    new Setting(containerEl)
      .setName("Maximum results")
      .setDesc("Number of results to show per search query. Range: 1–50.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 50, 1)
          .setValue(this.plugin.settings.maxResults)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxResults = value;
            await this.plugin.saveSettings();
          })
      );

    // --- Indexing ---
    new Setting(containerEl).setName("Indexing").setHeading();

    new Setting(containerEl)
      .setName("Auto-index on startup")
      .setDesc(
        "When enabled, Vault Mind will check for changed notes and update the index " +
        "every time Obsidian loads. Only changed files are re-embedded (incremental)."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoIndexOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.autoIndexOnStartup = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Batch size")
      .setDesc(
        "Files to embed per batch before yielding the UI thread. " +
        "Lower = smoother UI during indexing. Higher = faster overall. Default: 10."
      )
      .addSlider((slider) =>
        slider
          .setLimits(1, 50, 1)
          .setValue(this.plugin.settings.chunkSize)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.chunkSize = value;
            await this.plugin.saveSettings();
          })
      );

    // Full re-index button
    new Setting(containerEl)
      .setName("Re-index entire vault")
      .setDesc(
        "Wipe the existing index and re-embed all notes from scratch. " +
        "Use this if you change the embedding model or suspect index corruption. " +
        "This can take several minutes for large vaults."
      )
      .addButton((btn: ButtonComponent) =>
        btn
          .setButtonText("Re-index now")
          .setWarning()
          .onClick(async () => {
            btn.setDisabled(true);
            btn.setButtonText("Indexing...");
            try {
              await this.plugin.triggerFullReindex();
            } finally {
              btn.setDisabled(false);
              btn.setButtonText("Re-index now");
            }
          })
      );

    // --- Info ---
    new Setting(containerEl).setName("About").setHeading();
    const info = containerEl.createDiv({ cls: "vault-mind-about" });
    info.createEl("p", {
      text:
        "Vault Mind uses local AI embeddings to enable semantic search across your vault. " +
        "Your notes never leave your machine.",
    });
    info.createEl("p", {
      text: `Index contains ${this.plugin.getStore().noteCount} notes.`,
    });
  }
}
