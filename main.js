const obsidian = require("obsidian");

const {
  ItemView,
  Component,
  MarkdownRenderer,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  setIcon,
} = obsidian;

const moment = obsidian.moment || window.moment;
const VIEW_TYPE_MINI_MEMO = "mini-memo-view";

const DEFAULT_SETTINGS = {
  sectionHeading: "Mini Memo",
  hiddenTag: "#self",
  showHidden: false,
  historyLimitDays: 90,
  useDailyNotesCorePlugin: true,
  dailyNoteFolder: "",
  dailyNoteFormat: "YYYY-MM-DD",
};

module.exports = class MiniMemoPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.refreshTimer = 0;
    this.registerView(
      VIEW_TYPE_MINI_MEMO,
      (leaf) => new MiniMemoView(leaf, this)
    );

    this.addRibbonIcon("message-square-plus", "打开 Mini Memo", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-mini-memo",
      name: "打开 Mini Memo",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "toggle-hidden-memos",
      name: "切换隐藏记录展示",
      callback: async () => {
        this.settings.showHidden = !this.settings.showHidden;
        await this.saveSettings();
        await this.refreshViews();
      },
    });

    this.addSettingTab(new MiniMemoSettingTab(this.app, this));

    this.registerEvent(
      this.app.vault.on("create", (file) => this.handleVaultChange(file))
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => this.handleVaultChange(file))
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => this.handleVaultChange(file))
    );
    this.registerEvent(
      this.app.vault.on("rename", (file) => this.handleVaultChange(file))
    );
  }

  onunload() {
    window.clearTimeout(this.refreshTimer);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_MINI_MEMO);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    if (this.settings.hiddenTag === "#self#") {
      this.settings.hiddenTag = DEFAULT_SETTINGS.hiddenTag;
      await this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async activateView() {
    const existingLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_MINI_MEMO);
    existingLeaves.forEach((leaf) => leaf.detach());

    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_MINI_MEMO, active: true });

    this.app.workspace.revealLeaf(leaf);
  }

  handleVaultChange(file) {
    if (file instanceof TFile && file.extension === "md") {
      this.queueRefresh();
    }
  }

  queueRefresh() {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshViews();
    }, 250);
  }

  async refreshViews() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_MINI_MEMO);
    await Promise.all(
      leaves.map(async (leaf) => {
        if (leaf.view instanceof MiniMemoView) {
          await leaf.view.loadAndRenderRecords();
        }
      })
    );
  }

  getDailyNoteConfig() {
    const dailyNotesPlugin = this.app.internalPlugins?.plugins?.["daily-notes"];
    const options = dailyNotesPlugin?.instance?.options;

    if (this.settings.useDailyNotesCorePlugin && dailyNotesPlugin?.enabled && options) {
      return {
        folder: options.folder || "",
        format: options.format || DEFAULT_SETTINGS.dailyNoteFormat,
      };
    }

    return {
      folder: this.settings.dailyNoteFolder || "",
      format: this.settings.dailyNoteFormat || DEFAULT_SETTINGS.dailyNoteFormat,
    };
  }

  getDailyNotePath(date) {
    const config = this.getDailyNoteConfig();
    const datePath = moment(date).format(config.format).replace(/\.md$/i, "");
    const rawPath = [config.folder, datePath].filter(Boolean).join("/");
    return `${normalizeVaultPath(rawPath)}.md`;
  }

  async appendMemo(content) {
    const text = content.trim();
    if (!text) {
      return;
    }

    const now = new Date();
    const file = await this.getOrCreateDailyNote(now);
    const currentContent = await this.app.vault.read(file);
    const memoLine = formatMemoLine(text, now);
    const nextContent = insertMemoIntoSection(
      currentContent,
      this.getSectionHeading(),
      memoLine
    );

    await this.app.vault.modify(file, nextContent);
  }

  async getOrCreateDailyNote(date) {
    const path = this.getDailyNotePath(date);
    const existing = this.app.vault.getAbstractFileByPath(path);

    if (existing instanceof TFile) {
      return existing;
    }

    if (existing) {
      throw new Error(`目标日记路径不是文件：${path}`);
    }

    const folderPath = path.split("/").slice(0, -1).join("/");
    await this.ensureFolder(folderPath);
    return this.app.vault.create(path, "");
  }

  async ensureFolder(folderPath) {
    const normalized = normalizeVaultPath(folderPath);
    if (!normalized) {
      return;
    }

    const parts = normalized.split("/");
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);

      if (!existing) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  async loadRecords({ allHistory = false, minimumHistoryDays = 0 } = {}) {
    const config = this.getDailyNoteConfig();
    const files = this.app.vault.getMarkdownFiles();
    const configuredLimitDays = Number(this.settings.historyLimitDays) || 0;
    const limitDays = configuredLimitDays > 0
      ? Math.max(configuredLimitDays, minimumHistoryDays)
      : 0;
    const cutoff = !allHistory && limitDays > 0
      ? moment().startOf("day").subtract(limitDays - 1, "days")
      : null;
    const records = [];

    for (const file of files) {
      if (!isFileInFolder(file, config.folder)) {
        continue;
      }

      const noteDate = parseDailyNoteDate(file, config);
      if (!noteDate?.isValid()) {
        continue;
      }

      if (cutoff && noteDate.isBefore(cutoff, "day")) {
        continue;
      }

      const content = await this.app.vault.cachedRead(file);
      const section = extractSection(content, this.getSectionHeading());
      if (!section) {
        continue;
      }

      const parsedRecords = parseMemoItems(section, noteDate, file.path);
      records.push(...parsedRecords);
    }

    records.sort(
      (a, b) =>
        b.timestamp - a.timestamp ||
        b.sourcePosition - a.sourcePosition ||
        b.sourcePath.localeCompare(a.sourcePath)
    );
    return records;
  }

  getSectionHeading() {
    return normalizeHeading(this.settings.sectionHeading);
  }

  getHiddenTag() {
    return this.settings.hiddenTag?.trim() || DEFAULT_SETTINGS.hiddenTag;
  }

  async importImageFile(file) {
    if (!isImageFile(file)) {
      throw new Error("请选择图片文件");
    }

    const sourcePath = this.getDailyNotePath(new Date());
    const fileName = normalizeImageFileName(file.name);
    const attachmentPath = await this.getAvailableImagePath(fileName, sourcePath);
    const folderPath = attachmentPath.split("/").slice(0, -1).join("/");
    const data = await file.arrayBuffer();

    await this.ensureFolder(folderPath);

    const attachmentFile = await this.app.vault.createBinary(attachmentPath, data);
    return this.generateImageEmbed(attachmentFile, sourcePath);
  }

  async getAvailableImagePath(fileName, sourcePath) {
    const fileManager = this.app.fileManager;

    if (fileManager?.getAvailablePathForAttachment) {
      const attachmentPath = await fileManager.getAvailablePathForAttachment(
        fileName,
        sourcePath
      );
      return normalizeVaultPath(attachmentPath);
    }

    const folder = "Mini Memo Attachments";
    const extensionMatch = fileName.match(/(\.[^.]+)$/);
    const extension = extensionMatch ? extensionMatch[1] : "";
    const basename = extension
      ? fileName.slice(0, -extension.length)
      : fileName;
    let index = 0;

    while (true) {
      const suffix = index ? ` ${index}` : "";
      const candidate = normalizeVaultPath(`${folder}/${basename}${suffix}${extension}`);

      if (!this.app.vault.getAbstractFileByPath(candidate)) {
        return candidate;
      }

      index += 1;
    }
  }

  generateImageEmbed(file, sourcePath) {
    const fileManager = this.app.fileManager;
    const link = fileManager?.generateMarkdownLink
      ? fileManager.generateMarkdownLink(file, sourcePath)
      : `[[${file.path}]]`;

    return link.startsWith("!") ? link : `!${link}`;
  }
};

class MiniMemoView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.records = [];
    this.searchTimer = 0;
    this.searchRevision = 0;
    this.searching = false;
    this.searchMode = false;
    this.historyScrollTop = 0;
    this.closed = false;
  }

  getViewType() {
    return VIEW_TYPE_MINI_MEMO;
  }

  getDisplayText() {
    return "Mini Memo";
  }

  getIcon() {
    return "message-square-plus";
  }

  async onOpen() {
    this.renderShell();
    await this.loadAndRenderRecords();
  }

  async onClose() {
    this.closed = true;
    window.clearTimeout(this.searchTimer);
    this.searchRevision += 1;
    if (this.resultsComponent) this.removeChild(this.resultsComponent);
    this.contentEl.empty();
  }

  renderShell() {
    this.contentEl.empty();
    this.contentEl.addClass("mini-memo-view");

    this.rootEl = this.contentEl.createDiv({ cls: "mini-memo" });

    const composerEl = this.rootEl.createDiv({ cls: "mini-memo-composer" });
    this.composerEl = composerEl;

    this.inputEl = composerEl.createEl("textarea", {
      cls: "mini-memo-input",
      attr: {
        rows: "2",
        placeholder: "记录一点什么...",
        "aria-label": "记录内容",
      },
    });

    const footerEl = composerEl.createDiv({ cls: "mini-memo-composer-footer" });
    const actionEl = footerEl.createDiv({ cls: "mini-memo-composer-actions" });

    this.imageInputEl = actionEl.createEl("input", {
      cls: "mini-memo-image-input",
      attr: {
        type: "file",
        accept: "image/*",
        multiple: "true",
        "aria-label": "上传图片",
      },
    });

    this.imageButtonEl = actionEl.createEl("button", {
      cls: "mini-memo-icon-button mini-memo-image-button",
      attr: {
        type: "button",
        title: "上传图片",
        "aria-label": "上传图片",
      },
    });
    setIcon(this.imageButtonEl, "image-plus");
    this.imageButtonEl.addEventListener("click", () => {
      this.imageInputEl.click();
    });
    this.imageInputEl.addEventListener("change", () => {
      this.handleImageUpload();
    });

    this.sendButtonEl = footerEl.createEl("button", {
      cls: "mini-memo-send-button",
      attr: { type: "button", title: "发送", "aria-label": "发送" },
    });
    setIcon(this.sendButtonEl, "arrow-up");
    this.sendButtonEl.addEventListener("click", () => this.submitMemo());

    this.inputEl.addEventListener("input", () => this.updateSendState());
    this.inputEl.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        this.submitMemo();
      }
    });

    this.renderSearchControls();
    this.listScrollerEl = this.contentEl.createDiv({
      cls: "mini-memo-list-scroller",
    });
    this.listEl = this.listScrollerEl.createDiv({ cls: "mini-memo-list" });
    this.renderPageControls();
    this.updateHiddenToggle();
    this.updateSendState();
  }

  renderSearchControls() {
    const searchEl = this.rootEl.createDiv({ cls: "mini-memo-search" });
    this.searchEl = searchEl;
    searchEl.hidden = true;
    const toolbar = searchEl.createDiv({ cls: "mini-memo-search-toolbar" });
    const back = toolbar.createEl("button", {
      cls: "mini-memo-icon-button",
      attr: { type: "button", title: "返回记录", "aria-label": "返回记录" },
    });
    setIcon(back, "arrow-left");
    back.addEventListener("click", () => this.leaveSearch());
    const fieldEl = toolbar.createDiv({ cls: "mini-memo-search-field" });
    setIcon(fieldEl.createSpan({ cls: "mini-memo-search-icon" }), "search");
    this.searchInputEl = fieldEl.createEl("input", {
      attr: { type: "text", placeholder: "搜索历史记录…", "aria-label": "搜索历史记录" },
    });
    this.clearSearchEl = fieldEl.createEl("button", {
      cls: "mini-memo-search-clear",
      attr: { type: "button", title: "清除搜索", "aria-label": "清除搜索" },
    });
    setIcon(this.clearSearchEl, "x");
    this.clearSearchEl.hidden = true;
    this.clearSearchEl.addEventListener("click", () => this.clearSearch());
    this.searchInputEl.addEventListener("input", (event) => {
      if (!event.isComposing) this.scheduleSearch();
    });
    this.searchInputEl.addEventListener("compositionend", () => this.scheduleSearch());
    this.searchInputEl.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        this.clearSearch();
      }
    });

    this.dateToggleEl = toolbar.createEl("button", {
      cls: "mini-memo-icon-button",
      attr: { type: "button", title: "时间筛选", "aria-label": "时间筛选", "aria-expanded": "false" },
    });
    setIcon(this.dateToggleEl, "calendar-days");
    this.dateToggleEl.addEventListener("click", () => {
      this.filterPanelEl.hidden = !this.filterPanelEl.hidden;
      this.dateToggleEl.setAttr("aria-expanded", String(!this.filterPanelEl.hidden));
    });
    const metaEl = searchEl.createDiv({ cls: "mini-memo-search-meta" });
    this.searchStatusEl = metaEl.createSpan({ attr: { role: "status", "aria-live": "polite" } });
    this.filterPanelEl = searchEl.createDiv({ cls: "mini-memo-filter-panel" });
    this.filterPanelEl.hidden = true;
    this.rangeEl = this.filterPanelEl.createEl("select", { attr: { "aria-label": "时间范围" } });
    for (const [value, text] of [["all", "全部时间"], ["7", "最近 7 天"], ["30", "最近 30 天"], ["custom", "自定义日期"]]) {
      this.rangeEl.createEl("option", { text, value });
    }
    this.rangeEl.addEventListener("change", () => {
      this.dateRangeEl.hidden = this.rangeEl.value !== "custom";
      this.scheduleSearch(0);
    });
    this.dateRangeEl = this.filterPanelEl.createDiv({ cls: "mini-memo-date-range" });
    this.dateRangeEl.hidden = true;
    const startLabel = this.dateRangeEl.createEl("label", { text: "从" });
    this.startDateEl = startLabel.createEl("input", { attr: { type: "date", "aria-label": "开始日期" } });
    const endLabel = this.dateRangeEl.createEl("label", { text: "至" });
    this.endDateEl = endLabel.createEl("input", { attr: { type: "date", "aria-label": "结束日期" } });
    for (const input of [this.startDateEl, this.endDateEl]) {
      input.addEventListener("change", () => this.scheduleSearch(0));
    }
  }

  getSearchFilters() {
    if (!this.searchMode) return { query: "", range: "all", start: "", end: "" };
    return {
      query: this.searchInputEl.value.trim(),
      range: this.rangeEl.value,
      start: this.startDateEl.value,
      end: this.endDateEl.value,
    };
  }

  enterSearch() {
    if (this.searchMode) {
      this.searchInputEl.focus();
      return;
    }
    this.historyScrollTop = this.listScrollerEl.scrollTop;
    this.searchMode = true;
    this.composerEl.hidden = true;
    this.searchEl.hidden = false;
    this.searchButtonEl.setAttr("aria-pressed", "true");
    this.searchInputEl.focus();
    this.scheduleSearch(0);
  }

  leaveSearch() {
    window.clearTimeout(this.searchTimer);
    this.searchRevision += 1;
    this.searchMode = false;
    this.searching = false;
    this.searchEl.hidden = true;
    this.composerEl.hidden = false;
    this.searchButtonEl.setAttr("aria-pressed", "false");
    this.listEl.empty();
    this.inputEl.focus();
    this.loadAndRenderRecords(this.historyScrollTop);
  }

  scheduleSearch(delay = 200) {
    window.clearTimeout(this.searchTimer);
    this.searchRevision += 1;
    const filters = this.getSearchFilters();
    const active = this.searchMode || Boolean(filters.query || filters.range !== "all");
    if (!this.searchMode && !this.searching && active) this.historyScrollTop = this.listScrollerEl.scrollTop;
    this.searching = active;
    this.clearSearchEl.hidden = !filters.query && filters.range === "all" && !this.searchInputEl.value;
    if (this.dateToggleEl) {
      this.dateToggleEl.classList.toggle("is-active", filters.range !== "all");
      this.dateToggleEl.setAttr("title", this.rangeEl.selectedOptions[0]?.textContent || "时间筛选");
    }
    this.listEl.empty();
    this.searchStatusEl.setText(active ? "正在搜索…" : "");
    this.searchTimer = window.setTimeout(() => {
      this.loadAndRenderRecords(active ? 0 : this.historyScrollTop);
    }, delay);
  }

  clearSearch() {
    this.searchInputEl.value = "";
    this.rangeEl.value = "all";
    this.startDateEl.value = "";
    this.endDateEl.value = "";
    this.dateRangeEl.hidden = true;
    this.scheduleSearch(0);
    this.searchInputEl.focus();
  }

  renderPageControls() {
    const controlsEl = this.contentEl.createDiv({ cls: "mini-memo-page-controls" });
    const actionsEl = controlsEl.createDiv({ cls: "mini-memo-page-actions" });
    const statsEl = controlsEl.createDiv({
      cls: "mini-memo-stats",
      attr: { "aria-label": "笔记条数统计", "aria-live": "polite" },
    });
    this.statCountEls = new Map();
    for (const days of [7, 30, 90]) {
      const rowEl = statsEl.createDiv({ cls: "mini-memo-stat-row" });
      rowEl.createSpan({ cls: "mini-memo-stat-label", text: `${days}天` });
      const countEl = rowEl.createSpan({ cls: "mini-memo-stat-count", text: "—" });
      this.statCountEls.set(days, countEl);
    }
    this.hiddenToggleEl = actionsEl.createEl("button", {
      cls: "mini-memo-icon-button mini-memo-hidden-toggle",
      attr: { type: "button" },
    });
    this.hiddenToggleEl.addEventListener("click", async () => {
      this.plugin.settings.showHidden = !this.plugin.settings.showHidden;
      await this.plugin.saveSettings();
      await this.loadAndRenderRecords();
    });
    this.searchButtonEl = actionsEl.createEl("button", {
      cls: "mini-memo-icon-button",
      attr: { type: "button", title: "搜索历史记录", "aria-label": "搜索历史记录", "aria-pressed": "false" },
    });
    setIcon(this.searchButtonEl, "search");
    this.searchButtonEl.addEventListener("click", () => this.enterSearch());
  }

  async submitMemo() {
    const value = this.inputEl.value.trim();
    if (!value) {
      return;
    }

    this.sendButtonEl.disabled = true;
    this.inputEl.disabled = true;

    try {
      await this.plugin.appendMemo(value);
      this.inputEl.value = "";
      new Notice("已记录");
      await this.loadAndRenderRecords();
    } catch (error) {
      console.error(error);
      new Notice("记录失败，请检查日记设置");
    } finally {
      this.inputEl.disabled = false;
      this.updateSendState();
      this.inputEl.focus();
    }
  }

  async loadAndRenderRecords(scrollTop = this.listScrollerEl?.scrollTop || 0) {
    if (!this.listEl || this.closed) {
      return;
    }

    const revision = ++this.searchRevision;
    const filters = this.getSearchFilters();
    const active = this.searchMode || Boolean(filters.query || filters.range !== "all");
    try {
      const records = await this.plugin.loadRecords({ allHistory: active, minimumHistoryDays: 90 });
      if (revision !== this.searchRevision || this.closed) return;
      this.statsRecords = records;
      const limitDays = Number(this.plugin.settings.historyLimitDays) || 0;
      const cutoff = !active && limitDays > 0
        ? moment().startOf("day").subtract(limitDays - 1, "days").format("YYYY-MM-DD")
        : null;
      this.records = cutoff ? records.filter((record) => record.date >= cutoff) : records;
      await this.renderRecords(revision, filters, scrollTop);
    } catch (error) {
      if (revision !== this.searchRevision || this.closed) return;
      console.error(error);
      for (const countEl of this.statCountEls.values()) countEl.setText("—");
      this.listEl.empty();
      this.searchStatusEl.setText("读取记录失败，请重试");
      const retry = this.listEl.createEl("button", { text: "重试" });
      retry.addEventListener("click", () => this.loadAndRenderRecords(scrollTop));
    }
  }

  async renderRecords(revision, filters, scrollTop) {
    this.updateHiddenToggle();
    const active = this.searchMode || Boolean(filters.query || filters.range !== "all");
    const invalidRange = filters.range === "custom" && filters.start && filters.end && filters.start > filters.end;
    const visibleRecords = invalidRange ? [] : filterMemoRecords(this.records, {
      ...filters,
      showHidden: this.plugin.settings.showHidden,
      hiddenTag: this.plugin.getHiddenTag(),
    });
    const container = this.listEl.ownerDocument.createElement("div");
    const component = new Component();
    this.addChild(component);
    let committed = false;
    try {

    if (!visibleRecords.length) {
      container.createDiv({
        cls: "mini-memo-empty",
        text: invalidRange ? "开始日期不能晚于结束日期" : active ? "没有找到匹配的记录" : "还没有记录",
      });
      if (active) {
        const clear = container.createEl("button", { text: "清除搜索", cls: "mini-memo-empty-clear" });
        clear.addEventListener("click", () => this.clearSearch());
      }
    }

    for (const record of visibleRecords) {
      const itemEl = container.createDiv({ cls: "mini-memo-item" });
      const textEl = itemEl.createDiv({ cls: "mini-memo-item-text" });
      await MarkdownRenderer.render(
        this.app,
        normalizeMemoMediaSpacing(record.text),
        textEl,
        record.sourcePath,
        component
      );
      if (revision !== this.searchRevision || this.closed) return;
      highlightMemoMatches(textEl, filters.query);

      const footerEl = itemEl.createDiv({ cls: "mini-memo-item-footer" });
      footerEl.createDiv({
        cls: "mini-memo-item-time",
        text: formatRecordTime(record),
      });

      const forwardButtonEl = footerEl.createEl("button", {
        cls: "mini-memo-item-forward-button",
        attr: {
          type: "button",
          title: "引用这条记录",
          "aria-label": "引用这条记录",
        },
      });
      setIcon(forwardButtonEl, "forward");
      forwardButtonEl.addEventListener("click", () => {
        this.quoteRecord(record);
      });
    }
    if (revision !== this.searchRevision || this.closed) return;
    if (this.resultsComponent) this.removeChild(this.resultsComponent);
    this.resultsComponent = component;
    this.listEl.replaceChildren(...Array.from(container.childNodes));
    this.searchStatusEl.setText(invalidRange ? "日期范围无效" : active ? `找到 ${visibleRecords.length} 条记录` : "");
    this.listScrollerEl.scrollTop = scrollTop;
    this.updateRecordStats();
    committed = true;
    } finally {
      if (!committed) this.removeChild(component);
    }
  }

  updateHiddenToggle() {
    if (!this.hiddenToggleEl) {
      return;
    }

    const showHidden = this.plugin.settings.showHidden;
    const hiddenTag = this.plugin.getHiddenTag();
    const label = showHidden
      ? `隐藏带 ${hiddenTag} 的记录`
      : `展示带 ${hiddenTag} 的记录`;

    this.hiddenToggleEl.empty();
    setIcon(this.hiddenToggleEl, showHidden ? "eye" : "eye-off");
    this.hiddenToggleEl.classList.toggle("is-active", showHidden);
    this.hiddenToggleEl.setAttr("aria-pressed", showHidden ? "true" : "false");
    this.hiddenToggleEl.setAttr("aria-label", label);
    this.hiddenToggleEl.setAttr("title", label);
  }

  updateRecordStats() {
    const counts = countRecentMemoRecords(this.statsRecords || [], {
      showHidden: this.plugin.settings.showHidden,
      hiddenTag: this.plugin.getHiddenTag(),
    });
    for (const [days, countEl] of this.statCountEls) {
      countEl.setText(`${counts[days]}条`);
    }
  }

  updateSendState() {
    if (!this.sendButtonEl || !this.inputEl) {
      return;
    }

    this.sendButtonEl.disabled = !this.inputEl.value.trim() || this.inputEl.disabled;
  }

  async handleImageUpload() {
    const files = Array.from(this.imageInputEl.files || []);
    if (!files.length) {
      return;
    }

    this.imageButtonEl.disabled = true;

    try {
      const links = [];

      for (const file of files) {
        links.push(await this.plugin.importImageFile(file));
      }

      this.insertTextAtCursor(links.join("\n"));
      new Notice(files.length > 1 ? `已上传 ${files.length} 张图片` : "已上传图片");
    } catch (error) {
      console.error(error);
      new Notice("图片上传失败");
    } finally {
      this.imageInputEl.value = "";
      this.imageButtonEl.disabled = false;
      this.updateSendState();
      this.inputEl.focus();
    }
  }

  quoteRecord(record) {
    const quote = createMemoQuote(record.text);

    if (this.searchMode) {
      this.leaveSearch();
      this.inputEl.value = this.inputEl.value.trim() ? `${this.inputEl.value}\n${quote}` : quote;
    } else {
      this.inputEl.value = quote;
    }
    this.inputEl.focus();
    this.inputEl.setSelectionRange(0, 0);
    this.inputEl.scrollTop = 0;
    this.updateSendState();
  }

  insertTextAtCursor(text) {
    const input = this.inputEl;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const before = input.value
      .slice(0, start)
      .replace(/[ \t]+$/, "")
      .replace(/\n[ \t]*\n+$/, "\n");
    const after = input.value
      .slice(end)
      .replace(/^[ \t]+/, "")
      .replace(/^(?:\n[ \t]*){2,}/, "\n");
    const cleanText = text.trim();
    const prefix = before && !before.endsWith("\n") ? "\n" : "";
    const suffix = after && !after.startsWith("\n") ? "\n" : "";
    const insertion = `${prefix}${cleanText}${suffix}`;

    input.value = `${before}${insertion}${after}`;
    const cursor = before.length + insertion.length;
    input.setSelectionRange(cursor, cursor);
    this.updateSendState();
  }
}

class MiniMemoSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("记录标题")
      .setDesc("记录会写入日记中这个 Markdown 标题的下面。")
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.sectionHeading)
          .setValue(this.plugin.settings.sectionHeading)
          .onChange(async (value) => {
            this.plugin.settings.sectionHeading = normalizeHeading(value);
            await this.plugin.saveSettings();
            await this.plugin.refreshViews();
          });
      });

    new Setting(containerEl)
      .setName("隐藏标签")
      .setDesc("包含这个标签的记录会被右上角开关控制是否展示。")
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.hiddenTag)
          .setValue(this.plugin.settings.hiddenTag)
          .onChange(async (value) => {
            this.plugin.settings.hiddenTag = value.trim() || DEFAULT_SETTINGS.hiddenTag;
            await this.plugin.saveSettings();
            await this.plugin.refreshViews();
          });
      });

    new Setting(containerEl)
      .setName("读取天数")
      .setDesc("历史列表读取最近多少天的日记；设为 0 表示不限。")
      .addText((text) => {
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.historyLimitDays))
          .setValue(String(this.plugin.settings.historyLimitDays))
          .onChange(async (value) => {
            const days = Math.max(0, Number.parseInt(value, 10) || 0);
            this.plugin.settings.historyLimitDays = days;
            await this.plugin.saveSettings();
            await this.plugin.refreshViews();
          });
      });

    new Setting(containerEl)
      .setName("跟随核心日记设置")
      .setDesc("开启后优先使用 Obsidian 核心 Daily notes 插件的目录和日期格式。")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.useDailyNotesCorePlugin)
          .onChange(async (value) => {
            this.plugin.settings.useDailyNotesCorePlugin = value;
            await this.plugin.saveSettings();
            await this.plugin.refreshViews();
            this.display();
          });
      });

    if (!this.plugin.settings.useDailyNotesCorePlugin) {
      new Setting(containerEl)
        .setName("日记目录")
        .setDesc("不跟随核心日记设置时使用；留空表示仓库根目录。")
        .addText((text) => {
          text
            .setPlaceholder("Daily")
            .setValue(this.plugin.settings.dailyNoteFolder)
            .onChange(async (value) => {
              this.plugin.settings.dailyNoteFolder = normalizeVaultPath(value);
              await this.plugin.saveSettings();
              await this.plugin.refreshViews();
            });
        });

      new Setting(containerEl)
        .setName("日期格式")
        .setDesc("不跟随核心日记设置时使用，支持 Obsidian 日记常用的 Moment 格式。")
        .addText((text) => {
          text
            .setPlaceholder(DEFAULT_SETTINGS.dailyNoteFormat)
            .setValue(this.plugin.settings.dailyNoteFormat)
            .onChange(async (value) => {
              this.plugin.settings.dailyNoteFormat = value.trim() || DEFAULT_SETTINGS.dailyNoteFormat;
              await this.plugin.saveSettings();
              await this.plugin.refreshViews();
            });
        });
    }
  }
}

function formatMemoLine(text, date) {
  const time = moment(date).format("HH:mm");
  const lines = normalizeMemoMediaSpacing(text)
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const firstLine = lines.shift() || "";
  const continuation = lines.map((line) => `  ${line}`).join("\n");

  return continuation
    ? `- ${time} ${firstLine}\n${continuation}`
    : `- ${time} ${firstLine}`;
}

function insertMemoIntoSection(content, heading, memoLine) {
  const normalizedContent = content.replace(/\r\n/g, "\n");
  const headingRegex = new RegExp(`^(#{1,6})\\s+${escapeRegExp(heading)}\\s*$`, "m");
  const match = headingRegex.exec(normalizedContent);

  if (!match) {
    const prefix = normalizedContent.trimEnd();
    const section = `## ${heading}\n${memoLine}\n`;
    return prefix ? `${prefix}\n\n${section}` : section;
  }

  const headingLevel = match[1].length;
  const sectionStart = match.index + match[0].length;
  const afterHeading = normalizedContent.slice(sectionStart);
  const nextHeadingRegex = new RegExp(`^#{1,${headingLevel}}\\s+`, "m");
  const nextHeading = nextHeadingRegex.exec(afterHeading);
  const sectionEnd = nextHeading
    ? sectionStart + nextHeading.index
    : normalizedContent.length;

  const beforeSectionEnd = normalizedContent.slice(0, sectionEnd).trimEnd();
  const afterSection = normalizedContent.slice(sectionEnd).replace(/^\n*/, "");
  const suffix = afterSection ? `\n\n${afterSection}` : "";

  return `${beforeSectionEnd}\n${memoLine}\n${suffix}`;
}

function extractSection(content, heading) {
  const normalizedContent = content.replace(/\r\n/g, "\n");
  const headingRegex = new RegExp(`^(#{1,6})\\s+${escapeRegExp(heading)}\\s*$`, "m");
  const match = headingRegex.exec(normalizedContent);

  if (!match) {
    return "";
  }

  const headingLevel = match[1].length;
  const sectionStart = match.index + match[0].length;
  const afterHeading = normalizedContent.slice(sectionStart);
  const nextHeadingRegex = new RegExp(`^#{1,${headingLevel}}\\s+`, "m");
  const nextHeading = nextHeadingRegex.exec(afterHeading);

  return nextHeading ? afterHeading.slice(0, nextHeading.index) : afterHeading;
}

function parseMemoItems(section, noteDate, sourcePath) {
  const lines = section.split("\n");
  const records = [];
  let currentRecord = null;

  for (const [sourcePosition, line] of lines.entries()) {
    const item = /^-\s+(?:\[[ xX]\]\s+)?(\d{1,2}:\d{2})\s*(.*)$/.exec(line);

    if (item) {
      pushRecord(records, currentRecord);
      currentRecord = createRecord(
        noteDate,
        item[1],
        item[2],
        sourcePath,
        sourcePosition
      );
      continue;
    }

    if (currentRecord && /^( {2,}|\t)/.test(line)) {
      currentRecord.text += `\n${line.trimEnd().trimStart()}`;
    }
  }

  pushRecord(records, currentRecord);
  return records;
}

function createRecord(noteDate, time, text, sourcePath, sourcePosition) {
  const timestamp = moment(
    `${noteDate.format("YYYY-MM-DD")} ${time}`,
    // Written times use HH:mm; also accept older, unpadded hours.
    ["YYYY-MM-DD HH:mm", "YYYY-MM-DD H:mm"],
    true
  ).valueOf();

  return {
    text: text.trim(),
    time,
    date: noteDate.format("YYYY-MM-DD"),
    timestamp,
    sourcePath,
    sourcePosition,
  };
}

function pushRecord(records, record) {
  if (record && record.text) {
    records.push(record);
  }
}

function parseDailyNoteDate(file, config) {
  const pathWithoutExtension = file.path.replace(/\.md$/i, "");
  const folder = normalizeVaultPath(config.folder || "");
  const relativePath = folder && pathWithoutExtension.startsWith(`${folder}/`)
    ? pathWithoutExtension.slice(folder.length + 1)
    : pathWithoutExtension;

  const candidates = [
    [relativePath, config.format || DEFAULT_SETTINGS.dailyNoteFormat],
    [file.basename, config.format || DEFAULT_SETTINGS.dailyNoteFormat],
    [file.basename, DEFAULT_SETTINGS.dailyNoteFormat],
  ];

  for (const [value, format] of candidates) {
    const parsed = moment(value, format, true);
    if (parsed.isValid()) {
      return parsed.startOf("day");
    }
  }

  const dateMatch = file.basename.match(/\d{4}-\d{2}-\d{2}/);
  if (dateMatch) {
    const parsed = moment(dateMatch[0], DEFAULT_SETTINGS.dailyNoteFormat, true);
    if (parsed.isValid()) {
      return parsed.startOf("day");
    }
  }

  return null;
}

function isFileInFolder(file, folderPath) {
  const folder = normalizeVaultPath(folderPath || "");
  if (!folder) {
    return true;
  }
  return file.path.startsWith(`${folder}/`);
}

function formatRecordTime(record) {
  const today = moment().startOf("day");
  const recordDay = moment(record.date, "YYYY-MM-DD", true).startOf("day");

  if (recordDay.isSame(today, "day")) {
    return `今天 ${record.time}`;
  }

  if (recordDay.isSame(today.clone().subtract(1, "day"), "day")) {
    return `昨天 ${record.time}`;
  }

  return `${record.date} ${record.time}`;
}

function normalizeHeading(value) {
  const heading = (value || DEFAULT_SETTINGS.sectionHeading)
    .replace(/^#+\s*/, "")
    .trim();
  return heading || DEFAULT_SETTINGS.sectionHeading;
}

function normalizeVaultPath(value) {
  const path = String(value || "").trim();
  if (!path) {
    return "";
  }
  return normalizePath(path).replace(/^\/+/, "").replace(/\/+$/, "");
}

function isImageFile(file) {
  if (!file) {
    return false;
  }

  return Boolean(
    file.type?.startsWith("image/") ||
    /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i.test(file.name || "")
  );
}

function normalizeImageFileName(value) {
  const name = String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ");

  return name || `image-${moment().format("YYYYMMDD-HHmmss")}.png`;
}

function normalizeMemoMediaSpacing(text) {
  return String(text || "").replace(
    /\n(?:[ \t]*\n)+([ \t]*(?:!\[\[|!\[[^\]\n]*\]\(|<img\b))/gi,
    "\n$1"
  );
}

function createMemoQuote(text) {
  const content = normalizeMemoMediaSpacing(text).trim();

  return ` @ ${content}`;
}

function countRecentMemoRecords(records, { showHidden, hiddenTag }, today = moment()) {
  const end = today.format("YYYY-MM-DD");
  const counts = { 7: 0, 30: 0, 90: 0 };
  const starts = Object.keys(counts).map((days) => [
    days,
    today.clone().startOf("day").subtract(Number(days) - 1, "days").format("YYYY-MM-DD"),
  ]);
  for (const record of records) {
    if (record.date > end || (!showHidden && record.text.includes(hiddenTag))) continue;
    for (const [days, start] of starts) {
      if (record.date >= start) counts[days] += 1;
    }
  }
  return counts;
}

function filterMemoRecords(records, filters) {
  const query = filters.query.toLowerCase();
  let start = filters.range === "custom" ? filters.start : "";
  let end = filters.range === "custom" ? filters.end : "";
  if (filters.range === "7" || filters.range === "30") {
    start = moment().startOf("day").subtract(Number(filters.range) - 1, "days").format("YYYY-MM-DD");
    end = moment().format("YYYY-MM-DD");
  }
  return records.filter((record) =>
    (filters.showHidden || !record.text.includes(filters.hiddenTag)) &&
    (!query || record.text.toLowerCase().includes(query)) &&
    (!start || record.date >= start) &&
    (!end || record.date <= end)
  );
}

function highlightMemoMatches(element, query) {
  if (!query) return;
  const doc = element.ownerDocument;
  const walker = doc.createTreeWalker(element, 4);
  const nodes = [];
  while (walker.nextNode()) {
    if (!walker.currentNode.parentElement.closest("script, style, textarea, mark")) {
      nodes.push(walker.currentNode);
    }
  }
  const pattern = new RegExp(escapeRegExp(query), "gi");
  for (const node of nodes) {
    const text = node.nodeValue;
    const fragment = doc.createDocumentFragment();
    let offset = 0;
    for (const match of text.matchAll(pattern)) {
      fragment.append(doc.createTextNode(text.slice(offset, match.index)));
      const mark = doc.createElement("mark");
      mark.className = "mini-memo-search-match";
      mark.textContent = match[0];
      fragment.append(mark);
      offset = match.index + match[0].length;
    }
    if (offset) {
      fragment.append(doc.createTextNode(text.slice(offset)));
      node.replaceWith(fragment);
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
