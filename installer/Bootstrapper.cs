using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyProduct("AutoReply")]
[assembly: AssemblyTitle("AutoReply 安装与更新")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: TargetFramework(".NETFramework,Version=v4.8")]

sealed class ReleasePackage {
  internal readonly Version Version;
  internal readonly string Name, Sha256;
  internal readonly long Bytes;
  internal readonly Uri Url;

  internal ReleasePackage(Version version, string name, long bytes, string sha256, Uri url) {
    Version = version; Name = name; Bytes = bytes; Sha256 = sha256; Url = url;
  }
}

sealed class ReleaseClient : IDisposable {
  const string Prefix = "https://github.com/kyle-1227/AutoReply/releases/";
  const int IndexLimit = 1024 * 1024;
  const long PackageLimit = 300L * 1024 * 1024;
  static readonly Regex VersionPattern = new Regex(@"\A(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\z");
  static readonly Regex ShaPattern = new Regex(@"\A[0-9a-fA-F]{64}\z");
  static readonly string[] AssetHosts = {
    "release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com",
  };
  readonly HttpClient client;

  internal ReleaseClient(HttpMessageHandler handler = null) {
    client = new HttpClient(handler ?? new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false });
    client.Timeout = Timeout.InfiniteTimeSpan;
    client.DefaultRequestHeaders.UserAgent.ParseAdd("AutoReply-Installer/1.0");
  }

  internal static Version ParseVersion(string text) {
    Version parsed;
    if (text == null || !VersionPattern.IsMatch(text) || !Version.TryParse(text, out parsed))
      throw new InvalidDataException("版本号格式无效。");
    return parsed;
  }

  internal static Dictionary<string, object> Json(string text) {
    try {
      var result = new JavaScriptSerializer { MaxJsonLength = IndexLimit, RecursionLimit = 16 }
        .DeserializeObject(text.TrimStart('\uFEFF')) as Dictionary<string, object>;
      if (result != null) return result;
    } catch (ArgumentException) { }
    catch (InvalidOperationException) { }
    throw new InvalidDataException("无法解析版本清单。");
  }

  internal static object Field(Dictionary<string, object> values, string name) {
    object value;
    return values.TryGetValue(name, out value) ? value : null;
  }

  internal static ReleasePackage ReadPackage(string json, Version target) {
    var index = Json(json);
    if (ParseVersion(Field(index, "version") as string) != target)
      throw new InvalidDataException("正式发布标签与版本清单不一致。");
    string name = "AutoReply-Setup-" + target + "-win-x64.exe";
    var files = Field(index, "files") as object[];
    var matches = (files ?? new object[0]).OfType<Dictionary<string, object>>()
      .Where(entry => String.Equals(Field(entry, "name") as string, name, StringComparison.Ordinal)).ToArray();
    if (matches.Length != 1) throw new InvalidDataException("正式发布缺少唯一匹配的 Windows 安装包。");
    object length = Field(matches[0], "bytes");
    long bytes = length is int ? (int)length : length is long ? (long)length : 0;
    string sha = Field(matches[0], "sha256") as string;
    if (bytes < 1 || bytes > PackageLimit || sha == null || !ShaPattern.IsMatch(sha))
      throw new InvalidDataException("安装包大小或 SHA-256 校验信息无效。");
    return new ReleasePackage(target, name, bytes, sha.ToLowerInvariant(), new Uri(Prefix + "download/v" + target + "/" + name));
  }

  static Uri Redirect(HttpResponseMessage response, Uri from) {
    int code = (int)response.StatusCode;
    var location = response.Headers.Location;
    if (code < 300 || code >= 400 || location == null) return null;
    var to = new Uri(from, location);
    if (to.Scheme != Uri.UriSchemeHttps || !to.IsDefaultPort || to.UserInfo.Length != 0)
      throw new InvalidDataException("下载地址未通过 HTTPS 校验。");
    return to;
  }

  async Task<HttpResponseMessage> OpenAsset(Uri url, CancellationToken token) {
    for (int i = 0; i < 4; i++) {
      var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, token);
      if (response.StatusCode == HttpStatusCode.OK) return response;
      using (response) {
        var next = Redirect(response, url);
        if (next == null || !AssetHosts.Contains(next.Host, StringComparer.OrdinalIgnoreCase))
          throw new InvalidDataException("无法从正式发布下载附件，请检查网络或发布状态。");
        url = next;
      }
    }
    throw new InvalidDataException("正式发布附件重定向次数过多。");
  }

  internal async Task<ReleasePackage> CheckAsync(CancellationToken token) {
    using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(token)) {
      timeout.CancelAfter(TimeSpan.FromSeconds(45));
      var latest = new Uri(Prefix + "latest/download/CURRENT.json");
      Uri indexUrl;
      using (var response = await client.GetAsync(latest, HttpCompletionOption.ResponseHeadersRead, timeout.Token))
        indexUrl = Redirect(response, latest);
      string downloadPrefix = Prefix + "download/v";
      const string indexSuffix = "/CURRENT.json";
      if (indexUrl == null || !indexUrl.AbsoluteUri.StartsWith(downloadPrefix, StringComparison.Ordinal) ||
          !indexUrl.AbsoluteUri.EndsWith(indexSuffix, StringComparison.Ordinal))
        throw new InvalidDataException("无法定位 GitHub 最新正式版的 CURRENT.json。");
      string tag = indexUrl.AbsoluteUri.Substring(downloadPrefix.Length,
        indexUrl.AbsoluteUri.Length - downloadPrefix.Length - indexSuffix.Length);
      Version target = ParseVersion(tag);
      using (var response = await OpenAsset(indexUrl, timeout.Token))
      using (timeout.Token.Register(() => response.Dispose()))
      using (var stream = await response.Content.ReadAsStreamAsync())
      using (var data = new MemoryStream()) {
        var buffer = new byte[8192];
        int read;
        while ((read = await stream.ReadAsync(buffer, 0, buffer.Length, timeout.Token)) > 0) {
          if (data.Length + read > IndexLimit) throw new InvalidDataException("版本清单超过大小限制。");
          data.Write(buffer, 0, read);
        }
        return ReadPackage(new UTF8Encoding(false, true).GetString(data.ToArray()), target);
      }
    }
  }

  internal async Task DownloadAsync(ReleasePackage package, string path, IProgress<int> progress, CancellationToken token) {
    using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(token)) {
      timeout.CancelAfter(TimeSpan.FromMinutes(5));
      using (var response = await OpenAsset(package.Url, timeout.Token))
      using (timeout.Token.Register(() => response.Dispose()))
      using (var body = await response.Content.ReadAsStreamAsync())
      using (var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true))
      using (var hash = SHA256.Create()) {
        var buffer = new byte[65536];
        int read, percent = 0;
        long total = 0;
        while ((read = await body.ReadAsync(buffer, 0, buffer.Length, timeout.Token)) > 0) {
          total += read;
          if (total > package.Bytes) throw new InvalidDataException("安装包超出正式发布记录的大小。");
          hash.TransformBlock(buffer, 0, read, null, 0);
          await file.WriteAsync(buffer, 0, read, timeout.Token);
          int complete = (int)(100L * total / package.Bytes);
          if (progress != null && complete != percent) { percent = complete; progress.Report(percent); }
        }
        hash.TransformFinalBlock(new byte[0], 0, 0);
        string actual = BitConverter.ToString(hash.Hash).Replace("-", "").ToLowerInvariant();
        if (total != package.Bytes || actual != package.Sha256)
          throw new InvalidDataException("安装包大小或 SHA-256 校验失败，安装尚未开始。");
        await file.FlushAsync(timeout.Token);
      }
    }
    var info = FileVersionInfo.GetVersionInfo(path);
    if (info.ProductName != "AutoReply" || info.FileVersion != package.Version.ToString())
      throw new InvalidDataException("安装程序内部版本与正式发布版本不一致。");
  }

  public void Dispose() { client.Dispose(); }
}

sealed class InstalledApp {
  const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\AutoReply";
  internal readonly string Root;
  internal readonly Version Version;
  internal readonly bool Complete;

  internal InstalledApp(string root, Version version, bool complete) {
    Root = root; Version = version; Complete = complete;
  }

  static Version FileVersion(string path) {
    if (!File.Exists(path)) return null;
    return ReleaseClient.ParseVersion(ReleaseClient.Field(ReleaseClient.Json(File.ReadAllText(path)), "version") as string);
  }

  internal static InstalledApp Read() {
    using (var user = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry32))
    using (var key = user.OpenSubKey(UninstallKey)) {
      if (key == null) return null;
      var directory = key.GetValue("InstallLocation") as string;
      if (String.IsNullOrWhiteSpace(directory) || !Path.IsPathRooted(directory) || Path.GetPathRoot(directory).Length < 3)
        throw new InvalidDataException("无法识别原安装目录，请检查本机 AutoReply 的安装记录。");
      string root = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar);
      var registered = ReleaseClient.ParseVersion(key.GetValue("DisplayVersion") as string);
      var package = FileVersion(Path.Combine(root, "package.json"));
      var extension = FileVersion(Path.Combine(root, "extension", "manifest.json"));
      string hostPath = Path.Combine(root, "AutoReplyHost.exe");
      Version host = null;
      Version file;
      // Early installers shipped the launcher without an application version resource.
      if (File.Exists(hostPath) && Version.TryParse(FileVersionInfo.GetVersionInfo(hostPath).ProductVersion, out file) && file.Build >= 0)
        host = new Version(file.Major, file.Minor, file.Build);
      Version latest = new[] { registered, package, extension, host }.Where(version => version != null).Max();
      return new InstalledApp(root, latest, registered == latest && package == latest && extension == latest && host == latest);
    }
  }

  internal static bool CanInstall(InstalledApp installed, Version target) {
    return installed == null || target > installed.Version || (target == installed.Version && !installed.Complete);
  }

  internal bool HasWorker {
    get {
      return File.Exists(Path.Combine(Root, "server", "update-worker.js")) &&
        File.Exists(Path.Combine(Root, "runtime", "node.exe")) && File.Exists(Path.Combine(Root, "AutoReplyHost.exe")) &&
        File.Exists(Path.Combine(Root, "package.json")) && File.Exists(Path.Combine(Root, "extension", "manifest.json"));
    }
  }
}

sealed class InstallerWindow : Form {
  readonly Label installedLabel = new Label { AutoSize = true };
  readonly Label releaseLabel = new Label { AutoSize = true };
  readonly Label status = new Label { AutoSize = true, MaximumSize = new Size(470, 0) };
  readonly ProgressBar progress = new ProgressBar { Width = 470, Height = 14, Visible = false };
  readonly Button install = new Button { Text = "安装", AutoSize = true, Enabled = false };
  readonly Button check = new Button { Text = "检查更新", AutoSize = true };
  readonly Button close = new Button { Text = "关闭", AutoSize = true, DialogResult = DialogResult.Cancel };
  readonly ReleaseClient client = new ReleaseClient();
  CancellationTokenSource operation;
  InstalledApp installed;
  ReleasePackage candidate;
  bool applying, closing;

  internal InstallerWindow() {
    Text = "AutoReply 安装与更新";
    Font = SystemFonts.MessageBoxFont;
    AutoScaleMode = AutoScaleMode.Font;
    FormBorderStyle = FormBorderStyle.FixedDialog;
    StartPosition = FormStartPosition.CenterScreen;
    MaximizeBox = false; MinimizeBox = false;
    AutoSize = true; AutoSizeMode = AutoSizeMode.GrowAndShrink;
    var buttons = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight };
    buttons.Controls.AddRange(new Control[] { install, check, close });
    var layout = new FlowLayoutPanel {
      Dock = DockStyle.Fill, AutoSize = true, WrapContents = false, FlowDirection = FlowDirection.TopDown, Padding = new Padding(20),
    };
    layout.Controls.AddRange(new Control[] { installedLabel, releaseLabel, status, progress, buttons });
    Controls.Add(layout);
    CancelButton = close;
    close.Click += (sender, args) => Close();
    check.Click += async (sender, args) => await CheckAsync();
    install.Click += async (sender, args) => await InstallAsync();
    Shown += async (sender, args) => await CheckAsync();
    FormClosing += (sender, args) => {
      if (operation == null) return;
      args.Cancel = true;
      if (!applying) { closing = true; operation.Cancel(); }
    };
    FormClosed += (sender, args) => client.Dispose();
  }

  void ShowVersions() {
    installedLabel.Text = "本机版本  " + (installed == null ? "未安装" : installed.Version.ToString() +
      (installed.Complete ? "" : "（登记或组件版本不一致）"));
    releaseLabel.Text = "最新正式版  " + (candidate == null ? "—" : candidate.Version.ToString());
    install.Text = installed == null ? "安装" : candidate != null && installed.Version == candidate.Version ? "修复安装" : "更新";
    install.Enabled = operation == null && candidate != null && InstalledApp.CanInstall(installed, candidate.Version);
  }

  void Begin() {
    operation = new CancellationTokenSource();
    install.Enabled = false; check.Enabled = false;
  }

  void End() {
    operation.Dispose(); operation = null; applying = false;
    progress.Visible = false; check.Enabled = true; close.Enabled = true;
    if (closing) Close(); else ShowVersions();
  }

  async Task CheckAsync() {
    if (operation != null) return;
    Begin();
    candidate = null;
    status.Text = "正在检查 GitHub 正式版…";
    try {
      installed = InstalledApp.Read();
      ShowVersions();
      candidate = await client.CheckAsync(operation.Token);
      if (installed == null) status.Text = "可以安装最新正式版。";
      else if (installed.Version > candidate.Version)
        status.Text = "本机有高于最新正式版的版本记录，已保留本机安装。";
      else if (installed.Version < candidate.Version) status.Text = "发现新版本。更新前请先暂停任务并关闭使用 AutoReply 的浏览器环境。";
      else if (!installed.Complete) status.Text = "检测到组件或扩展版本不一致，可以修复安装。";
      else status.Text = "当前已是最新正式版本。";
    } catch (OperationCanceledException) { if (!closing) status.Text = "检查版本超时，请重试。"; }
    catch (Exception error) { status.Text = ErrorMessage(error, "暂时无法检查正式版，请检查网络后重试。"); }
    finally { End(); }
  }

  async Task InstallAsync() {
    if (operation != null || candidate == null) return;
    Begin();
    string temporary = null;
    try {
      installed = InstalledApp.Read();
      if (!InstalledApp.CanInstall(installed, candidate.Version)) {
        status.Text = "本机版本已变化，请重新检查更新。";
        return;
      }
      CheckNotInUse();
      temporary = Path.Combine(Path.GetTempPath(), "AutoReply-Install-" + Guid.NewGuid().ToString("N"));
      Directory.CreateDirectory(temporary);
      string installer = Path.Combine(temporary, candidate.Name);
      progress.Value = 0; progress.Visible = true;
      status.Text = "正在下载安装包并校验 SHA-256…";
      await client.DownloadAsync(candidate, installer, new Progress<int>(value => progress.Value = value), operation.Token);
      operation.Token.ThrowIfCancellationRequested();
      installed = InstalledApp.Read();
      if (!InstalledApp.CanInstall(installed, candidate.Version))
        throw new InvalidDataException("下载期间本机版本已变化，请重新检查更新。");
      CheckNotInUse();
      applying = true; close.Enabled = false;
      status.Text = installed == null ? "请在安装向导中完成安装。" : "正在覆盖安装并核验版本…";
      string oldRoot = installed == null ? null : installed.Root;
      bool usedWorker = installed != null && installed.HasWorker;
      if (usedWorker) await RunWorkerAsync(installer, temporary);
      else await RunInstallerAsync(installer, oldRoot);
      installed = InstalledApp.Read();
      if (installed == null || !installed.Complete || installed.Version != candidate.Version ||
          (oldRoot != null && !String.Equals(oldRoot, installed.Root, StringComparison.OrdinalIgnoreCase)))
        throw new InvalidDataException("安装完成后的组件或扩展文件版本未通过核验。");
      status.Text = usedWorker
        ? "已更新本机组件和受控扩展。重新打开浏览器环境后，在 AutoReply 中核对版本。"
        : "安装完成。请在浏览器加载安装目录中的 extension，保留原有 AutoReply 扩展条目。";
    } catch (OperationCanceledException) { if (!closing) status.Text = "下载安装包超时，请重试。"; }
    catch (Exception error) { status.Text = ErrorMessage(error, "安装未完成，请检查安装目录和浏览器状态后重试。"); }
    finally {
      if (temporary != null) {
        try {
          foreach (string file in new[] { candidate.Name, "offline-update.mjs", "node.exe" })
            File.Delete(Path.Combine(temporary, file));
          Directory.Delete(temporary);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
      }
      End();
    }
  }

  static string ErrorMessage(Exception error, string fallback) {
    return error is InvalidDataException ? error.Message : fallback;
  }

  static void CheckNotInUse() {
    Mutex inUse;
    if (!Mutex.TryOpenExisting(@"Local\AutoReply.Component.InUse", out inUse)) return;
    using (inUse) throw new InvalidDataException("AutoReply 正在使用。请先暂停任务，再关闭使用插件的浏览器环境。");
  }

  static async Task RunInstallerAsync(string file, string previousRoot) {
    var start = new ProcessStartInfo(file) { UseShellExecute = false };
    // NSIS requires /D last and consumes the unquoted remainder as the directory.
    if (previousRoot != null) start.Arguments = "/S /D=" + previousRoot;
    using (var process = Process.Start(start)) {
      await Task.Run(() => process.WaitForExit());
      if (process.ExitCode == 20) throw new InvalidDataException("AutoReply 正在使用，请关闭相关浏览器环境后重试。");
      if (process.ExitCode != 0) throw new InvalidDataException("安装向导已取消或未完成。");
    }
  }

  async Task RunWorkerAsync(string installer, string temporary) {
    string script = Path.Combine(temporary, "offline-update.mjs");
    string runtime = Path.Combine(temporary, "node.exe");
    using (var content = Assembly.GetExecutingAssembly().GetManifestResourceStream("AutoReply.OfflineUpdate"))
    using (var output = File.Create(script)) content.CopyTo(output);
    File.Copy(Path.Combine(installed.Root, "runtime", "node.exe"), runtime);
    var start = new ProcessStartInfo(runtime, "\"" + script + "\"") {
      UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true,
      StandardOutputEncoding = Encoding.UTF8, WorkingDirectory = temporary,
    };
    start.EnvironmentVariables.Remove("NODE_OPTIONS");
    start.EnvironmentVariables.Remove("OPENROUTER_API_KEY");
    using (var process = Process.Start(start)) {
      string input = new JavaScriptSerializer().Serialize(new { root = installed.Root, installer = installer,
        version = candidate.Version.ToString(), bytes = candidate.Bytes, sha256 = candidate.Sha256 });
      // An ASCII escape for each Unicode code unit keeps redirected stdin independent of the Windows code page.
      process.StandardInput.WriteLine(Regex.Replace(input, @"[^\x00-\x7F]", match => "\\u" + ((int)match.Value[0]).ToString("x4")));
      process.StandardInput.Close();
      string output = await process.StandardOutput.ReadToEndAsync();
      await Task.Run(() => process.WaitForExit());
      var result = ReleaseClient.Json(output);
      if (process.ExitCode != 0 || !Object.Equals(ReleaseClient.Field(result, "ok"), true))
        throw new InvalidDataException(ReleaseClient.Field(result, "message") as string ?? "覆盖安装未完成，请检查 AutoReply 的版本更新状态。");
    }
  }

  [STAThread]
  static void Main() {
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    bool first;
    using (var entry = new Mutex(true, @"Local\AutoReply.Bootstrapper", out first)) {
      if (!first) {
        MessageBox.Show("AutoReply 安装与更新窗口已打开。", "AutoReply");
        return;
      }
      try {
        if (Environment.Is64BitOperatingSystem) Application.Run(new InstallerWindow());
        else MessageBox.Show("AutoReply 需要 Windows 10／11 x64。", "AutoReply");
      } finally { entry.ReleaseMutex(); }
    }
  }
}
