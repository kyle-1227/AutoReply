using System;
using System.IO;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Management;

// Binary pipe bridge and DPAPI helpers for the current Windows user's Key.
class NativeHost {
  static string RootMutex(string root) {
    using (var hash = SHA256.Create()) return "Local\\AutoReply.Root." + BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(root).TrimEnd('\\').ToLowerInvariant()))).Replace("-", "").Substring(0, 24);
  }
  static string ReadKey(string root, string name) {
    string file = Path.Combine(root, "config", name);
    if (!File.Exists(file)) return "";
    try {
      return Encoding.Unicode.GetString(ProtectedData.Unprotect(File.ReadAllBytes(file), null, DataProtectionScope.CurrentUser)).Trim();
    } catch (CryptographicException) {
      Console.Error.WriteLine("MODEL_KEY_UNAVAILABLE");
      return "";
    }
  }

  static void SaveKey(string root, string name) {
    string key;
    using (var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true))) key = input.ReadToEnd().Trim();
    if (key.Length == 0 || key.Length > 4096) throw new ArgumentException();
    foreach (char value in key) if (char.IsControl(value) || char.IsWhiteSpace(value)) throw new ArgumentException();
    byte[] encrypted = ProtectedData.Protect(Encoding.Unicode.GetBytes(key), null, DataProtectionScope.CurrentUser);
    string directory = Path.Combine(root, "config");
    Directory.CreateDirectory(directory);
    string temporary = Path.Combine(directory, "openrouter-key." + Guid.NewGuid().ToString("N") + ".tmp");
    using (var writer = new Mutex(false, "Local\\AutoReply.Key.Write")) {
      bool acquired;
      try { acquired = writer.WaitOne(5000); } catch (AbandonedMutexException) { acquired = true; }
      if (!acquired) throw new TimeoutException();
      try {
        using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
          stream.Write(encrypted, 0, encrypted.Length);
          stream.Flush(true);
        }
        string target = Path.Combine(directory, name);
        if (File.Exists(target)) File.Replace(temporary, target, null);
        else File.Move(temporary, target);
      } finally {
        if (File.Exists(temporary)) File.Delete(temporary);
        writer.ReleaseMutex();
      }
    }
  }

  static async Task CopyAndFlush(Stream input, Stream output) {
    byte[] buffer = new byte[8192];
    int count;
    while ((count = await input.ReadAsync(buffer, 0, buffer.Length)) > 0) {
      await output.WriteAsync(buffer, 0, count);
      // Small Native Messaging frames must not wait in FileStream's buffer.
      await output.FlushAsync();
    }
  }
  // Pass only the owning browser's PID and kind to the component.
  static void SetBrowserIdentity(ProcessStartInfo start) {
    try {
      int pid = Process.GetCurrentProcess().Id;
      for (int depth = 0; depth < 10 && pid > 0; depth++) {
        using (var query = new ManagementObjectSearcher("SELECT ParentProcessId,Name,ExecutablePath FROM Win32_Process WHERE ProcessId=" + pid))
        using (var rows = query.Get()) {
          int parent = 0;
          foreach (ManagementObject value in rows) {
            string name = Convert.ToString(value["Name"]).ToLowerInvariant();
            string path = Convert.ToString(value["ExecutablePath"]);
            bool chromiumCore = path.IndexOf("Chrome-bin", StringComparison.OrdinalIgnoreCase) >= 0;
            if (name == "chrome.exe" || name == "msedge.exe" || (name == "bitbrowser.exe" && chromiumCore)) {
              bool bitBrowser = chromiumCore || path.IndexOf("BitBrowser", StringComparison.OrdinalIgnoreCase) >= 0;
              start.EnvironmentVariables["AUTOREPLY_BROWSER_PID"] = pid.ToString();
              start.EnvironmentVariables["AUTOREPLY_BROWSER_KIND"] = bitBrowser ? "bitbrowser" : name == "msedge.exe" ? "edge" : "chrome";
              return;
            }
            parent = Convert.ToInt32(value["ParentProcessId"]);
          }
          pid = parent;
        }
      }
    } catch { /* An unidentified browser cannot be restarted automatically. */ }
  }
  static void Main(string[] args) {
    if (args.Length == 1 && args[0] == "--component-version") {
      using (var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false))) output.Write(typeof(NativeHost).Assembly.GetName().Version.ToString(3));
      return;
    }
    if (args.Length == 1 && args[0] == "--in-use") {
      try { using (Mutex value = Mutex.OpenExisting(RootMutex(AppDomain.CurrentDomain.BaseDirectory))) { Environment.ExitCode = 1; } }
      catch (WaitHandleCannotBeOpenedException) { Environment.ExitCode = 0; }
      return;
    }
    if (args.Length == 2 && args[0] == "--installer-version") {
      var info = FileVersionInfo.GetVersionInfo(args[1]);
      if (info.ProductName != "AutoReply") { Environment.ExitCode = 1; return; }
      using (var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false))) output.Write(info.FileVersion);
      return;
    }
    using (var inUse = new Mutex(false, "Local\\AutoReply.Component.InUse"))
    using (var rootUse = new Mutex(false, RootMutex(AppDomain.CurrentDomain.BaseDirectory))) {
      Process child = null;
      try {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        if (args.Length == 1 && (args[0] == "--save-key" || args[0] == "--save-update-key")) { SaveKey(root, args[0] == "--save-key" ? "openrouter-key.dat" : "bitbrowser-key.dat"); return; }
        if (args.Length == 1 && (args[0] == "--read-key" || args[0] == "--read-update-key")) {
          using (var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false))) {
            output.Write(ReadKey(root, args[0] == "--read-key" ? "openrouter-key.dat" : "bitbrowser-key.dat"));
          }
          return;
        }
        var start = new ProcessStartInfo(Path.Combine(root, "runtime", "node.exe")) {
          Arguments = "\"" + Path.Combine(root, "server", "native-host.js") + "\"",
          WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
          RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        start.EnvironmentVariables.Remove("OPENROUTER_API_KEY");
        SetBrowserIdentity(start);
        child = Process.Start(start);
        using (Stream input = Console.OpenStandardInput())
        using (Stream output = Console.OpenStandardOutput())
        using (Stream error = Console.OpenStandardError()) {
          var process = child;
          Task incoming = Task.Run(async () => {
            try { await CopyAndFlush(input, process.StandardInput.BaseStream); } catch (IOException) { }
            finally { try { process.StandardInput.Close(); } catch (InvalidOperationException) { } }
          });
          Task outgoing = CopyAndFlush(process.StandardOutput.BaseStream, output);
          Task errors = CopyAndFlush(process.StandardError.BaseStream, error);
          Task.WaitAny(incoming, outgoing);
          if (!process.WaitForExit(2000)) process.Kill();
          outgoing.Wait(2000); errors.Wait(2000); output.Flush();
        }
      } catch (Exception) {
        Environment.ExitCode = 1;
        Console.Error.WriteLine("NATIVE_HOST_FAILED");
      }
      finally {
        if (child != null) {
          try { if (!child.HasExited) child.Kill(); } catch (InvalidOperationException) { }
          child.Dispose();
        }
      }
      GC.KeepAlive(inUse);
      GC.KeepAlive(rootUse);
    }
  }
}
