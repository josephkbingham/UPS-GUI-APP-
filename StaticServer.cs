using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace UpsConsole {
    // Only packaged application assets are addressable. Serial I/O belongs to the browser.
    public sealed class StaticServer : IDisposable {
        readonly TcpListener listener;
        readonly Dictionary<string, string> files = new Dictionary<string, string>(StringComparer.Ordinal);
        readonly Dictionary<string, string> mime = new Dictionary<string, string> {
            { ".html", "text/html; charset=utf-8" }, { ".css", "text/css; charset=utf-8" },
            { ".js", "text/javascript; charset=utf-8" }, { ".woff2", "font/woff2" }
        };

        public StaticServer(string root, int port) {
            listener = new TcpListener(IPAddress.Loopback, port);
            root = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
            foreach (string path in Directory.GetFiles(root, "*", SearchOption.AllDirectories)) {
                if (mime.ContainsKey(Path.GetExtension(path)))
                    files.Add(path.Substring(root.Length).Replace('\\', '/'), path);
            }
        }

        public void Start() {
            listener.Start();
            listener.BeginAcceptTcpClient(Accept, null);
        }

        void Accept(IAsyncResult result) {
            try {
                TcpClient client = listener.EndAcceptTcpClient(result);
                listener.BeginAcceptTcpClient(Accept, null);
                ThreadPool.QueueUserWorkItem(delegate { Serve(client); });
            } catch (ObjectDisposedException) { }
              catch (SocketException) { }
        }

        void Serve(TcpClient client) {
            using (client) {
                try {
                    client.ReceiveTimeout = 4000;
                    client.SendTimeout = 4000;
                    using (NetworkStream stream = client.GetStream())
                    using (StreamReader reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true)) {
                        string first = reader.ReadLine();
                        if (first == null || first.Length > 4096) return;
                        string[] request = first.Split(' ');
                        if (request.Length < 3) return;
                        int size = first.Length;
                        string line;
                        while (!String.IsNullOrEmpty(line = reader.ReadLine())) {
                            size += line.Length;
                            if (size > 16384) return;
                        }
                        string path = request[1].Split('?')[0];
                        if (path == "/") path = "/index.html";
                        byte[] body;
                        string asset;
                        string type = "text/plain", status = "200 OK";
                        if (request[0] != "GET" && request[0] != "HEAD") {
                            status = "405 Method Not Allowed"; body = new byte[0];
                        } else if (!files.TryGetValue(path, out asset)) {
                            status = "404 Not Found"; body = new byte[0];
                        } else {
                            type = mime[Path.GetExtension(path)];
                            body = File.ReadAllBytes(asset);
                        }
                        string header = "HTTP/1.1 " + status + "\r\nContent-Type: " + type
                            + "\r\nContent-Length: " + body.Length.ToString(CultureInfo.InvariantCulture)
                            + "\r\nX-UPS-Console: 1\r\nCache-Control: no-store\r\nConnection: close"
                            + "\r\nX-Content-Type-Options: nosniff\r\nPermissions-Policy: serial=(self)\r\n\r\n";
                        byte[] prefix = Encoding.ASCII.GetBytes(header);
                        stream.Write(prefix, 0, prefix.Length);
                        if (request[0] == "GET") stream.Write(body, 0, body.Length);
                    }
                } catch (IOException) { }
                  catch (SocketException) { }
            }
        }
        public void Dispose() { listener.Stop(); }
    }
}
