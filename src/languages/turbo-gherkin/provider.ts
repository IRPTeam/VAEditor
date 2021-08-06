import { createTokenizationSupport } from 'monaco-editor/esm/vs/editor/standalone/common/monarch/monarchLexer';
import { StaticServices } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices';
import { TokenizationRegistry, ITokenizationSupport } from 'monaco-editor/esm/vs/editor/common/modes';
import { compile } from 'monaco-editor/esm/vs/editor/standalone/common/monarch/monarchCompile';
import { language, GherkinLanguage } from './configuration';
import { VanessaEditor } from "../../vanessa-editor";
import { IVanessaAction } from "../../common";
import { KeywordMatcher } from './matcher';
import * as distance from 'jaro-winkler';

interface IVanessaStep {
  filterText: string;
  insertText: string;
  sortText: string;
  documentation: string;
  kind: number;
  section: string;
}

interface IImportedItem {
  name: string;
  value?: any;
  table?: any;
  lines?: any;
}

interface IImportedFile {
  name: string;
  path: string;
  items: Array<IImportedItem>;
}

enum VAToken {
  Empty = 0,
  Section,
  Operator,
  Comment,
  Multiline,
  Instruction,
  Parameter,
}

interface VAIndent {
  token: VAToken;
  indent: number;
}

function trimQuotes(w: string) {
  return w.replace(/^["'](.*)["']$/, '$1');
}

export class VanessaGherkinProvider {

  public static get instance(): VanessaGherkinProvider { return window["VanessaGherkinProvider"]; }
  public get errorLinks(): any { return this._errorLinks; }
  public get elements(): any { return this._elements; }
  public get keywords(): any { return this._keywords; }
  public get keypairs(): any { return this._keypairs; }
  public get syntaxMsg(): any { return this._syntaxMsg; }
  public get variables(): any { return this._variables; }
  public get steps(): any { return this._steps; }

  protected _soundHint = "Sound";
  protected _syntaxMsg = "Syntax error";
  protected _keywords: string[][] = [];
  protected _metatags: string[] = ["try", "except", "попытка", "исключение"];
  protected _keypairs: any = {};
  protected _steps = {};
  protected _elements = {};
  protected _variables = {};
  protected _errorLinks = [];
  protected _imports = {};
  protected _matcher: KeywordMatcher;

  public get singleWords(): string[] {
    return this.keywords.filter(w => w.length == 1).map(w => w[0]);
  }

  public get metatags(): string[] {
    return this._metatags;
  }

  protected isSection(text: string, name: string = "") {
    const regexp = new RegExp(this.matcher.reg.section[name]);
    return regexp.test(text);
  }

  protected getSection(text: string) {
    const res = Object.keys(this.matcher.reg.section).filter(key => key && this.matcher.reg.section[key].test(text));
    return res && res[0];
  }

  protected splitWords(line: string): Array<string> {
    let regexp = /"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|<[^>]*>|[A-zА-яЁё]+|[^A-zА-яЁё\s]+/g;
    return line.match(regexp) || [];
  }

  protected findKeyword(words: Array<string>): Array<string> {
    if (words.length == 0) return undefined;
    let result = undefined;
    this.keywords.forEach((item: string[]) => {
      if (!result && item.every((w: string, i: number) => words[i] && w == words[i].toLowerCase())) result = item;
    });
    return result;
  }

  protected filterWords(words: Array<string>): Array<string> {
    let s = true;
    let keyword = this.findKeyword(words);
    let notComment = (w: string) => s && !(/^[\s]*[#|//]/.test(w));
    return words.filter((w, i) => (keyword && i < keyword.length) ? false : (notComment(w) ? true : s = false));
  }

  protected key(words: Array<string>): string {
    let result = [];
    words.forEach((w: string) => {
      if (/^[A-zА-яЁё]+$/.test(w)) result.push(w.toLowerCase());
    });
    return result.join(" ");
  }

  public setErrorLinks = (arg: string): void => {
    const commands = JSON.parse(arg)
    this.clearArray(this.errorLinks);
    commands.forEach((e: IVanessaAction) => {
      this.errorLinks.push(e);
    });
  }

  public get matcher() { return this._matcher; }

  public setMatchers = (arg: string): void => {
    this._matcher = new KeywordMatcher(arg);
    this.initTokenizer();
  }

  public setKeywords = (arg: string): void => {
    this.clearArray(this.keywords);
    let list = JSON.parse(arg).map((w: string) => w.toLowerCase());
    list.forEach((w: string) => this.keywords.push(w.split(" ")));
    this._keywords = this.keywords.sort((a: any, b: any) => b.length - a.length);
    this.initTokenizer();
  }

  public setKeypairs = (arg: string): void => {
    let pairs = JSON.parse(arg);
    this.clearObject(this.keypairs);
    Object.keys(pairs).forEach((key: string) => {
      let list = pairs[key].map((w: string) => w.toLowerCase());;
      this.keypairs[key.toLowerCase()] = list;
    });
  }

  public setMetatags = (arg: string): void => {
    let list = JSON.parse(arg);
    this.clearArray(this._metatags);
    list.forEach((w: string) => this._metatags.push(w));
    this.initTokenizer();
  }

  public setSoundHint = (arg: string): void => {
    this._soundHint = arg;
  }

  public setElements = (values: string, clear: boolean = false): void => {
    if (clear) this.clearObject(this.elements);
    let obj = JSON.parse(values);
    for (let key in obj) {
      this.elements[key.toLowerCase()] = obj[key];
    }
    this.updateStepLabels();
  }

  public setVariables = (values: string, clear: boolean = false): void => {
    if (clear) this.clearObject(this.variables);
    let obj = JSON.parse(values);
    for (let key in obj) {
      this.variables[key.toLowerCase()] = { name: key, value: String(obj[key]) };
    }
    this.updateStepLabels();
  }

  public setStepList = (list: string, clear: boolean = false): void => {
    if (clear) this.clearObject(this.steps);
    JSON.parse(list).forEach((e: IVanessaStep) => {
      let body = e.insertText.split('\n');
      let text = body.shift();
      let head = this.splitWords(text);
      let words = this.filterWords(head);
      let key = this.key(words);
      this.steps[key] = {
        head: head,
        body: body,
        documentation: e.documentation,
        insertText: e.insertText,
        sortText: e.sortText,
        section: e.section,
        kind: e.kind,
      };
    });
    this.updateStepLabels();
    VanessaEditor.checkAllSyntax();
  }

  public setSyntaxMsg = (message: string): void => {
    this._syntaxMsg = message;
  }

  public getSyntaxMsg = (): string => {
    return this._syntaxMsg;
  }

  private updateStepLabels() {
    for (let key in this.steps) {
      let e = this.steps[key];
      let words = e.head.map((word: string) => {
        let regexp = /^"[^"]*"$|^'[^']*'$|^<[^<]*>$/g;
        if (!regexp.test(word)) return word;
        let name = word.substring(1, word.length - 1).toLowerCase();
        let elem = this.elements[name];
        if (!elem) return word;
        let Q1 = word.charAt(0);
        let Q2 = word.charAt(word.length - 1);
        return `${Q1}${elem}${Q2}`;
      });
      let keyword = this.findKeyword(words);
      e.label = words.filter((w, i) => !(keyword && i < keyword.length)).join(' ');
      e.keyword = words.filter((w, i) => (keyword && i < keyword.length)).join(' ');
      e.insertText = e.label + (e.body.length ? '\n' + e.body.join('\n') : '');
    }
  }

  public constructor() {
    this.createTheme1C();
  }

  private clearObject(target: Object) {
    Object.keys(target).forEach(key => delete target[key]);
  }

  private clearArray(target: Array<any>) {
    target.splice(0, target.length);
  }

  private createTheme1C() {
    monaco.editor.defineTheme('1c', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: '', foreground: '000000' },
        { token: 'invalid', foreground: 'ff3333' },
        { token: 'variable', foreground: '5c6773' },
        { token: 'constant', foreground: 'f08c36' },
        { token: 'comment', foreground: '007f00' },
        { token: 'number', foreground: '0000ff' },
        { token: 'tag', foreground: 'e7c547' },
        { token: 'string', foreground: '963200' },
        { token: 'keyword', foreground: 'ff0000' },
      ],
      colors: {
        'editor.background': '#ffffff',
        'editor.foreground': '#5c6773',
        'editorIndentGuide.background': '#ecebec',
        'editorIndentGuide.activeBackground': '#e0e0e0',
      },
    });
  }

  private addQuickFix(model: monaco.editor.ITextModel, list: any, error: monaco.editor.IMarkerData) {
    let range = {
      startLineNumber: error.startLineNumber,
      endLineNumber: error.endLineNumber,
      startColumn: 1,
      endColumn: error.endColumn,
    };
    let value = model.getValueInRange(range);
    let words = this.splitWords(value);
    let keyword = this.findKeyword(words);
    if (keyword == undefined) return;
    let regexp = "^[\\s]*";
    keyword.forEach(w => regexp += w + "[\\s]+");
    let match = value.toLowerCase().match(new RegExp(regexp));
    if (match) range.startColumn = match[0].length + 1;
    let line = this.key(this.filterWords(words));
    for (let key in this.steps) {
      let sum = distance(line, key);
      if (sum > 0.7) list.push({ key: key, sum: sum, error: error, range: range, words: words });
    }
    list.sort((a, b) => b.sum - a.sum);
  }

  private replaceParams(step: string[], line: string[]): string {
    let index = 0;
    step = this.filterWords(step);
    let regexp = /^"[^"]*"$|^'[^']*'$|^<[^<]*>$/g;
    let test = (w: string) => (new RegExp(regexp.source)).test(w);
    let params = line.filter(w => test(w));
    return step.map(w => (test(w) && index < params.length) ? params[index++] : w).join(' ');
  }

  private getQuickFix(
    model: monaco.editor.ITextModel,
    markers: monaco.editor.IMarkerData[]
  ): monaco.languages.CodeActionList {
    let list = [];
    let actions: Array<monaco.languages.CodeAction> = [];
    markers.forEach(e => this.addQuickFix(model, list, e));
    list.forEach((e, i) => {
      if (i > 6) return;
      let step = this.steps[e.key];
      let text = this.replaceParams(step.head, e.words);
      actions.push({
        title: text,
        diagnostics: [e.error],
        kind: "quickfix",
        edit: {
          edits: [{
            resource: model.uri,
            edit: { range: e.range, text: text }
          }]
        },
        isPreferred: true
      });
    });
    return { actions: actions, dispose: () => { } };
  }

  public provideCodeActions(model: monaco.editor.ITextModel
    , range: monaco.Range
    , context: monaco.languages.CodeActionContext
    , token: monaco.CancellationToken
  ): monaco.languages.CodeActionList {
    if (context.markers.length == 0) return undefined;
    if (context.markers.every(e => e.severity != monaco.MarkerSeverity.Error)) return undefined;
    return this.getQuickFix(model, context.markers);
  }

  private getIndent(text: string, tabSize: number) {
    let indent = 0;
    let length = text.search(/[^\s]/)
    for (let i = 0; i < length; i++) {
      if (text.charAt(i) == "\t") {
        indent = indent + tabSize - (indent % tabSize);
      } else indent++;
    }
    return indent + 1;
  }

  public provideFoldingRanges(
    model: monaco.editor.ITextModel,
    context: monaco.languages.FoldingContext,
    token: monaco.CancellationToken,
  ): Array<monaco.languages.FoldingRange> {
    return this.getCodeFolding(
      model.getOptions().tabSize,
      model.getLineCount(),
      lineNumber => model.getLineContent(lineNumber)
    );
  }

  private getToken(text: string) {
    if (/^\s*$/.test(text)) return VAToken.Empty;
    if (/^[\s]*@/.test(text)) return VAToken.Instruction;
    if (/^[\s]*\|/.test(text)) return VAToken.Parameter;
    if (/^[\s]*[#|//]/.test(text)) return VAToken.Comment;
    if (/^[\s]*"""/.test(text)) return VAToken.Multiline;
    return VAToken.Operator;
  }

  public getCodeFolding(
    tabSize: number,
    lineCount: number,
    getLineContent: (lineNumber: number) => string
  ): Array<monaco.languages.FoldingRange> {
    let multiline = false;
    let lines: Array<VAIndent> = [{ token: VAToken.Empty, indent: 0 }];
    for (let lineNumber = 1; lineNumber <= lineCount; lineNumber++) {
      let text = getLineContent(lineNumber);
      let token = this.getToken(text);
      if (multiline) {
        if (token == VAToken.Multiline) multiline = false;
        token = VAToken.Multiline;
      } else {
        if (token == VAToken.Multiline) multiline = true;
      }
      if (token != VAToken.Operator) {
        lines.push({ token: token, indent: 0 });
      } else {
        let ident = 0;
        if (this.isSection(text)) token = VAToken.Section;
        else ident = this.getIndent(text, tabSize);
        lines.push({ token: token, indent: ident });
      }
    }
    let result = [];
    for (let i = 1; i <= lineCount; i++) {
      let k = i;
      let line = lines[i];
      let kind = undefined;
      switch (line.token) {
        case VAToken.Instruction:
          for (let j = i + 1; j <= lineCount; j++) {
            if (lines[j].token == VAToken.Instruction) k = j; else break;
          }
          break;
        case VAToken.Comment:
          kind = monaco.languages.FoldingRangeKind.Comment;
          for (let j = i + 1; j <= lineCount; j++) {
            if (lines[j].token == VAToken.Comment) k = j; else break;
          }
          break;
        case VAToken.Section:
          kind = monaco.languages.FoldingRangeKind.Region;
          for (let j = i + 1; j <= lineCount; j++) {
            if (lines[j].token == VAToken.Section) break; else k = j;
          }
          break;
        case VAToken.Operator:
          for (let j = i + 1; j <= lineCount; j++) {
            let next = lines[j];
            if (next.token == VAToken.Section) break;
            if (next.token == VAToken.Empty) continue;
            if (next.token == VAToken.Comment) { k = j; continue; }
            if (next.token == VAToken.Multiline) { k = j; continue; }
            if (next.token == VAToken.Parameter) { k = j; continue; }
            if (next.indent <= line.indent) break; else k = j;
          } break;
      }
      if (k > i) result.push({ kind: kind, start: i, end: k });
      if (line.token == VAToken.Instruction || line.token == VAToken.Comment) i = k;
    }
    return result;
  }

  private escapeMarkdown(text: string): string {
    // escape markdown syntax tokens: http://daringfireball.net/projects/markdown/syntax#backslash
    return text.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
  }

  public provideHover(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
  ): monaco.languages.Hover {
    let contents = [];
    let line = model.getLineContent(position.lineNumber)
    let match = line.match(/^\s*\*/);
    if (match) {
      let head = this._soundHint;
      let char = String.fromCharCode(60277);
      let href = "#sound:" + position.lineNumber;
      let text = line.substr(match[0].length);
      contents.push({ value: `**${head}** [${char}](${href})` });
      contents.push({ value: this.escapeMarkdown(text) });
    } else {
      let words = this.splitWords(line);
      let key = this.key(this.filterWords(words));
      let step = this.steps[key];
      if (step) {
        let i = String.fromCharCode(60020);
        let s = String.fromCharCode(60277);
        let t = this.escapeMarkdown(step.section);
        let ih = "#info:" + key.replace(/ /g, "-");
        let sh = "#sound:" + position.lineNumber;
        contents.push({ value: `**${t}** [${i}](${ih}) [${s}](${sh})` });
        contents.push({ value: this.escapeMarkdown(step.documentation) });
        let values = this.variables;
        let vars = line.match(/"[^"]+"|'[^']+'/g) || [];
        vars.forEach(function (part: string) {
          let d = /^.\$.+\$.$/.test(part) ? 2 : 1;
          let v = values[part.substring(d, part.length - d).toLowerCase()];
          if (v) contents.push({ value: "**" + v.name + "** = " + v.value });
        });
      }
    }
    let range = {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: model.getLineMinColumn(position.lineNumber),
      endColumn: model.getLineMaxColumn(position.lineNumber),
    };
    return { range: range, contents: contents }
  }

  private empty(position: monaco.Position
  ): monaco.languages.CompletionList {
    return {
      suggestions: [{
        label: '',
        insertText: '',
        kind: monaco.languages.CompletionItemKind.Function,
        range: {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: position.column - 1,
          endColumn: position.column,
        },
      }]
    };
  }

  public provideCompletionItems(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
  ): monaco.languages.CompletionList {
    let line = {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: model.getLineMinColumn(position.lineNumber),
      endColumn: model.getLineMaxColumn(position.lineNumber),
    };
    let wordRange = undefined;
    let regexp = /"[^"]*"|'[^']*'|<[^\s"']*>/g;
    let words = model.findMatches(regexp.source, line, true, false, null, false) || [];
    words.forEach(e => {
      if (e.range.startColumn <= position.column && position.column <= e.range.endColumn) {
        wordRange = e.range;
      }
    });
    let result: Array<monaco.languages.CompletionItem> = [];
    if (wordRange) {
      let variable = model.getValueInRange(wordRange);
      let Q1 = variable.charAt(0);
      let Q2 = variable.charAt(variable.length - 1);
      let S = /^.\$.+\$.$/.test(variable) ? "$" : "";
      for (let name in this.variables) {
        let item = this.variables[name];
        result.push({
          label: `"${S}${item.name}${S}" = ${item.value}`,
          filterText: variable + `${S}${item.name}${S}`,
          insertText: `${Q1}${S}${item.name}${S}${Q2}`,
          kind: monaco.languages.CompletionItemKind.Variable,
          range: wordRange
        })
      }
    } else {
      let maxColumn = model.getLineLastNonWhitespaceColumn(position.lineNumber);
      if (maxColumn && position.column < maxColumn) return this.empty(position);
      let minColumn = model.getLineFirstNonWhitespaceColumn(position.lineNumber);
      let line = model.getLineContent(position.lineNumber);
      let words = line.match(/[^\s]+/g) || [];
      let keyword = this.findKeyword(words);
      let range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: minColumn ? minColumn : position.column,
        endColumn: maxColumn ? maxColumn : position.column,
      };
      if (keyword) {
        let keytext = keyword.join(' ');
        keytext = keytext.charAt(0).toUpperCase() + keytext.slice(1);
        for (let key in this.steps) {
          let e = this.steps[key];
          if (e.documentation) {
            result.push({
              label: e.label,
              kind: e.kind ? e.kind : monaco.languages.CompletionItemKind.Function,
              detail: e.section,
              documentation: e.documentation,
              sortText: e.sortText,
              insertText: keytext + ' ' + e.insertText + '\n',
              filterText: keytext + ' ' + key,
              range: range
            });
          }
        }
      } else {
        this.metatags.forEach(word => {
          result.push({
            label: word,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: word + '\n',
            range: range
          });
        });
        for (let key in this.steps) {
          let e = this.steps[key];
          if (e.documentation) {
            result.push({
              label: e.label,
              kind: e.kind ? e.kind : monaco.languages.CompletionItemKind.Function,
              detail: e.section,
              documentation: e.documentation,
              sortText: e.sortText,
              insertText: e.keyword + ' ' + e.insertText + '\n',
              filterText: key,
              range: range
            });
          }
        }
      }
    }
    return { suggestions: result };
  }

  private lineSyntaxError(line: string, section: string): boolean {
    let match = line.match(this.matcher.reg.step);
    if (!match) return false;
    let words = this.splitWords(line);
    let keyword = this.findKeyword(words);
    if (keyword == undefined) return false;
    let s = true;
    let notComment = (w: string) => s && !(/^[\s]*[#|//]/.test(w));
    words = words.filter((w, i) => (i < keyword.length) ? false : (notComment(w) ? true : s = false));
    let key = this.key(words);
    if (key === "") return false;
    if (this.steps[key]) return false;
    let keypair = this.keypairs[keyword.join(" ")];
    if (!keypair) return true;
    let lastnum = words.length - 1;
    let lastword = words[lastnum].toLowerCase();
    let step = words.filter((w, i) => i < lastnum);
    return !(this.steps[this.key(step)] && keypair.some((w: string) => w == lastword));
  }

  public checkSyntax(model: monaco.editor.ITextModel) {
    if (model.getModeId() != "turbo-gherkin") return;
    let problems: monaco.editor.IMarkerData[] = [];
    let lineCount = model.getLineCount();
    let multiline = false;
    let section = "";
    for (let lineNumber = 1; lineNumber <= lineCount; lineNumber++) {
      const line: string = model.getLineContent(lineNumber);
      if (/^\s*""".*$/.test(line)) { multiline = !multiline; continue; }
      if (multiline) continue;
      if (/^\s*(#|@|\/\/)/.test(line)) continue;
      if (this.isSection(line)) { section = this.getSection(line); continue; }
      if (section == "feature") continue;
      if (this.lineSyntaxError(line, section)) problems.push({
        severity: monaco.MarkerSeverity.Error,
        message: this.syntaxMsg,
        startLineNumber: lineNumber,
        startColumn: model.getLineFirstNonWhitespaceColumn(lineNumber),
        endLineNumber: lineNumber,
        endColumn: model.getLineLastNonWhitespaceColumn(lineNumber),
      });
    }
    monaco.editor.setModelMarkers(model, "syntax", problems);
  }

  private tokenizer: ITokenizationSupport;

  public initTokenizer() {
    let lang = new GherkinLanguage(this);
    if (this.tokenizer) this.tokenizer.dispose();
    this.tokenizer = createTokenizationSupport(
      StaticServices.modeService.get(),
      StaticServices.standaloneThemeService.get(),
      language.id,
      compile(language.id, lang),
    );
  }

  public getInitialState(): monaco.languages.IState {
    return this.tokenizer.getInitialState();
  }

  public tokenize(line: string, state: monaco.languages.IState): monaco.languages.ILineTokens {
    let words = this.splitWords(line);
    let keyword = this.findKeyword(words);
    if (keyword) {
      if (words.length > keyword.length) {
        let keypair = this.keypairs[keyword.join(" ")] || [];
        let lastnum = words.length - 1;
        let lastword = words[lastnum].toLowerCase();
        if (keypair.some((w: string) => w == lastword)) {
          let regexp = new RegExp(lastword + "\\s*$");
          let match = line.toLowerCase().match(regexp);
          if (match) {
            let length = match[0].length;
            line = line.substring(0, match.index);
            for (let i = 0; i < length; ++i) line += "҂";
          }
        }
      }
    }
    let tokens = [];
    let result = this.tokenizer.tokenize(line, state, 0);
    result.tokens.forEach((t: monaco.Token) => tokens.push({ startIndex: t.offset, scopes: t.type }));
    return { tokens: tokens, endState: result.endState };
  }

  public logTokens(model: monaco.editor.ITextModel) {
    let tokenizationSupport = TokenizationRegistry.get("turbo-gherkin");
    if (tokenizationSupport) {
      var state = tokenizationSupport.getInitialState();
      let lineCount = model.getLineCount();
      for (var lineNumber = 1; lineNumber <= lineCount; lineNumber++) {
        let line: string = model.getLineContent(lineNumber);
        var tokenizationResult = tokenizationSupport.tokenize(line, state, 0);
        state = tokenizationResult.endState;
        console.log(lineNumber, state.stack.state, tokenizationResult.tokens);
      }
    };
  }

  public setImports = (values: string): void => {
    let result = {};
    let array = JSON.parse(values) as Array<IImportedFile>;
    array.forEach(file => {
      let data = result[file.name] = { "": {} };
      file.items.forEach(item => {
        const key = (item.name || "").toLowerCase();
        if (item.value) {
          data[""][key] = { key: item.name, name: item.value.text, file: file.path };
        } else if (item.lines) {
          const text = item.lines.lines.map(w => w.text).join('\n');
          data[""][key] = { key: item.name, name: text, file: file.path };
        } else if (item.table) {
          if (key) data[key] = {};
          const columns = item.table.head.tokens.map(e => e.text);
          item.table.body.forEach(row => {
            const t = row.tokens;
            const i = (t[0].text || "").toLowerCase();
            let x = data[key][i] = { key: t[0].text, name: t[1].text, file: file.path, data: {} };
            for (let col = 0; col < columns.length; col++)
              x.data[columns[col]] = t[col].text;
          });
        }
      })
    });
    this._imports = result;
  }

  private getLinks(model: monaco.editor.ITextModel, position: { lineNumber: number, lineCount: number }) {
    let links_reg = new RegExp(this.matcher.reg.section.variables);
    let import_reg = new RegExp(this.matcher.reg.import.source + "(.+)");
    for (let lineNumber = 1; lineNumber <= position.lineCount - 1; lineNumber++) {
      let line: string = model.getLineContent(lineNumber);
      if (line.match(links_reg)) {
        let matches = undefined;
        let tableName = "";
        let columns = null;
        let links = { "": {} };
        let multiline = false;
        let multitext = "";
        let multidata = {};
        for (let i = lineNumber + 1; i <= position.lineCount; i++) {
          let line: string = model.getLineContent(i);
          if (/^\s*""".*$/.test(line)) { if (multiline = !multiline) multitext = ""; continue; }
          if (multiline) { multitext += (multitext == "" ? "" : "\n") + line; multidata["name"] = multitext; continue; }
          if (line.match(/^\s*\|/)) {
            let match = line.match(/"(\\\|[^"])*"|'(\\'|[^'])*'|[^\s\|][^\|]*[^\s\|]|[^\s\|]/g);
            if (match === null) continue;
            if (columns === null) {
              columns = match.map(trimQuotes);
            } else {
              match = match.map(trimQuotes);
              while (match.length < columns.length) match.push("");
              let row = { key: match[0], name: match[1], data: {} };
              for (let col = 0; col < columns.length; col++) row.data[columns[col]] = match[col];
              if (links[tableName] == undefined) links[tableName] = {};
              links[tableName][match[0].toLowerCase()] = row;
            }
          } else if ((matches = line.match(/^\s*([A-zА-яЁё][0-9A-zА-яЁё]*)\s*=\s*(.*)\s*$/)) != null) {
            tableName = "";
            columns = null;
            multidata = {};
            let key = matches[1].toLowerCase();
            let value = matches[2].trim();
            if (links[tableName] == undefined) links[tableName] = {};
            multidata = links[tableName][key] = { key: key, name: value };
          } else if ((matches = line.match(import_reg)) !== null) {
            tableName = "";
            columns = null;
            multidata = {};
            let filename = trimQuotes(matches[3].trim()).toLowerCase();
            let vars = this._imports[filename];
            if (vars) {
              Object.keys(vars[""]).forEach(key => { links[""][key] = vars[""][key] });
              Object.keys(vars).forEach(key => { if (key) links[key] = vars[key] });
            }
          } else if (line.match(/^\s*(#|@|\/\/)/)) {
            continue;
          } else if ((matches = line.match(/^\s*\*/)) !== null) {
            tableName = line.substr(matches[0].length).trim().toLowerCase();
          } else if (this.isSection(line)) {
            position.lineNumber = i;
            return links;
          } else {
            if (columns) tableName = "";
            columns = null;
            multidata = {};
          }
        }
      }
    }
    position.lineNumber = position.lineCount;
    return {};
  }

  public getLinkData(editor: monaco.editor.IStandaloneCodeEditor, key: string) {
    const model = editor.getModel();
    let position = { lineNumber: 1, lineCount: model.getLineCount() };
    let words = key.split(".").map((w: string) => w.toLowerCase());
    let links = this.getLinks(model, position);
    let data = (table: string, row: string, col: string = undefined): any => {
      if (links[table] && links[table][row]) {
        let obj = links[table][row];
        if (col) obj["column"] = col;
        obj["table"] = table;
        obj["param"] = key;
        return obj;
      } else if (col == undefined) return data("", table, row);
    }
    switch (words.length) {
      case 1: return data("", words[0]);
      case 2: return data(words[0], words[1]);
      case 3: return data(words[0], words[1], words[2]);
    }
  }

  public provideLinks(model: monaco.editor.ITextModel, token: monaco.CancellationToken)
    : monaco.languages.ProviderResult<monaco.languages.ILinksList> {
    let result = [];
    let pos = { lineNumber: 1, lineCount: model.getLineCount() };
    let links = this.getLinks(model, pos);
    let pattern = /(["'])((?:\\\1|(?:(?!\1)).)*)(\1)/;
    for (var lineNumber = 1; lineNumber <= pos.lineCount; lineNumber++) {
      let matches = undefined;
      let regexp = new RegExp(pattern.source, "g");
      let line: string = model.getLineContent(lineNumber);
      while ((matches = regexp.exec(line)) !== null) {
        let range = new monaco.Range(lineNumber, matches.index + 2, lineNumber, regexp.lastIndex);
        let param = matches[0].substring(1, matches[0].length - 1);
        let e1cib = /^e1cib\/[^\s]+$/;
        if (e1cib.test(param)) {
          result.push({ range: range, url: trimQuotes(matches[0]) });
        } else if (lineNumber > pos.lineNumber) {
          let pattern = /^([A-zА-яЁё][0-9A-zА-яЁё]*)(\.[A-zА-яЁё][0-9A-zА-яЁё]*)*$/;
          let add = (table: string, row: string, col: string = undefined): any => {
            if (links[table] && links[table][row]) {
              let obj = links[table][row];
              let text = obj.name;
              if (col) Object.keys(obj.data).forEach((key: string) => {
                if (key.toLowerCase() == col) text = obj.data[key];
              });
              result.push({ range: range, tooltip: text, url: "link:" + param });
            } else if (col == undefined) add("", table, row);
          }
          if (pattern.test(param)) {
            let words = param.split(".").map((w: string) => w.toLowerCase());
            switch (words.length) {
              case 1: add("", words[0]); break;
              case 2: add(words[0], words[1]); break;
              case 3: add(words[0], words[1], words[2]); break;
            }
          }
        }
      }
    }
    return { links: result };
  }
}
