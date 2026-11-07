// End-to-end Shell flows against an in-test native-rpc/1 peer (spec §11; V1-D02/04/07/08/09/10/11/12).
// The peer answers with fixture-shaped data; every request is recorded so the test checks what the Shell sent.
#include "fake_gateway.hpp"
#include "gui_support.hpp"

#include <QClipboard>
#include <QColor>
#include <QDateTime>
#include <QGuiApplication>
#include <QJsonDocument>
#include <QQuickStyle>
#include <QJsonArray>
#include <QJsonObject>
#include <QtEndian>
#include <QWheelEvent>
#include <QTemporaryDir>
#include <atomic>
#include <cstring>
#include <mutex>
#include <thread>

#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

using namespace agentos;
using namespace agentos::test;

static const QString WS_A = QStringLiteral("44444444-4444-4444-8444-444444444444");
static const QString WS_B = QStringLiteral("55555555-5555-4555-8555-555555555555");

static QStringList g_qmlWarnings;
static QtMessageHandler g_prev = nullptr;
static void captureQml(QtMsgType t, const QMessageLogContext& c, const QString& m) {
  if (t >= QtWarningMsg && (m.contains(QLatin1String("qrc:/agentos/qml")) || m.contains(QLatin1String("qml:")))) g_qmlWarnings << m;
  if (g_prev) g_prev(t, c, m);
}

/** The login session agent's socket ($XDG_RUNTIME_DIR/agentos-session.sock, 4-byte big-endian length + JSON), answering
 *  like native/crates/desktop-session: status, audio.setVolume/setMute, display.set (15 s revert), display.keep. It
 *  runs on its own thread because the Shell talks to the agent with blocking calls. */
struct FakeSessionAgent {
  QString path;
  int fd = -1;
  std::thread th;
  std::mutex m;
  QVector<QJsonObject> reqs;
  int volume = 40;
  bool muted = false;
  explicit FakeSessionAgent(const QString& dir) : path(dir + QStringLiteral("/agentos-session.sock")) {
    fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    sockaddr_un a{};
    a.sun_family = AF_UNIX;
    const QByteArray p = path.toUtf8();
    std::strncpy(a.sun_path, p.constData(), sizeof(a.sun_path) - 1);
    ::unlink(p.constData());
    if (::bind(fd, reinterpret_cast<sockaddr*>(&a), sizeof(a)) == 0 && ::listen(fd, 8) == 0) th = std::thread([this] { loop(); });
  }
  ~FakeSessionAgent() {
    ::shutdown(fd, SHUT_RDWR);
    ::close(fd);
    if (th.joinable()) th.join();
    ::unlink(path.toUtf8().constData());
  }
  QVector<QJsonObject> requests() {
    std::lock_guard<std::mutex> g(m);
    return reqs;
  }
  QVector<QJsonObject> ops(const QString& op) {
    QVector<QJsonObject> out;
    for (const auto& r : requests())
      if (r.value(QStringLiteral("op")).toString() == op) out << r;
    return out;
  }
  static bool readN(int c, char* b, size_t n) {
    while (n > 0) {
      const ssize_t k = ::read(c, b, n);
      if (k <= 0) return false;
      b += k;
      n -= size_t(k);
    }
    return true;
  }
  QJsonObject answer(const QJsonObject& r) {
    const QString op = r.value(QStringLiteral("op")).toString();
    const auto audio = [&] { return QJsonObject{{QStringLiteral("available"), true}, {QStringLiteral("volume"), volume}, {QStringLiteral("muted"), muted}}; };
    const auto mode = [](int w, int h) { return QJsonObject{{QStringLiteral("width"), w}, {QStringLiteral("height"), h}, {QStringLiteral("refresh"), 60000}}; };
    if (op == QLatin1String("status"))
      return {{QStringLiteral("locked"), false}, {QStringLiteral("lockMinutes"), 5}, {QStringLiteral("audio"), audio()}, {QStringLiteral("backlight"), false},
              {QStringLiteral("outputs"), QJsonArray{QJsonObject{{QStringLiteral("name"), QStringLiteral("Virtual-1")}, {QStringLiteral("active"), true}, {QStringLiteral("scale"), 1.0},
                                                                 {QStringLiteral("current"), mode(1280, 800)}, {QStringLiteral("modes"), QJsonArray{mode(1280, 800), mode(1920, 1080), mode(1920, 1080)}}}}}};
    if (op == QLatin1String("audio.setVolume")) volume = r.value(QStringLiteral("percent")).toInt();
    if (op == QLatin1String("audio.setMute")) muted = r.value(QStringLiteral("muted")).toBool();
    if (op.startsWith(QLatin1String("audio."))) return audio();
    if (op == QLatin1String("display.set")) return {{QStringLiteral("applied"), true}, {QStringLiteral("revertInSeconds"), 15}};
    if (op == QLatin1String("display.keep")) return {{QStringLiteral("kept"), true}};
    return {};
  }
  void loop() {
    for (;;) {
      const int c = ::accept(fd, nullptr, nullptr);
      if (c < 0) return;
      for (;;) {
        char h[4];
        if (!readN(c, h, 4)) break;
        const quint32 n = qFromBigEndian<quint32>(reinterpret_cast<const uchar*>(h));
        QByteArray body(int(n), '\0');
        if (n > 65536 || !readN(c, body.data(), n)) break;
        const QJsonObject r = QJsonDocument::fromJson(body).object();
        QJsonObject data;
        {
          std::lock_guard<std::mutex> g(m);
          reqs << r;
          data = answer(r);
        }
        const QByteArray out = QJsonDocument(QJsonObject{{QStringLiteral("ok"), true}, {QStringLiteral("data"), data}}).toJson(QJsonDocument::Compact);
        QByteArray f(4, '\0');
        qToBigEndian<quint32>(quint32(out.size()), reinterpret_cast<uchar*>(f.data()));
        f += out;
        if (::write(c, f.constData(), size_t(f.size())) != f.size()) break;
      }
      ::close(c);
    }
  }
};

/** Scripted machine state the peer answers from. */
struct Backend {
  std::atomic<int> sessionEpoch{1};
  std::atomic<bool> locked{false};
  std::atomic<bool> backgroundEnabled{false}, workspaceOwner{true}, nativeStatusShape{false};
  bool plannedBackground = false;
  std::atomic<bool> withNotification{false}, forbidRuns{false};
  std::atomic<bool> hostDown{false}, modelDown{false}, brokerDown{false}, planStale{false}, holdQueries{false}, holdRecordLists{false};
  JValue kanban = loadFixture(QStringLiteral("v1.0/slot-vectors/scenario-v2-kanban.json"));
  JValue console = loadFixture(QStringLiteral("v1.0/slot-vectors/scenario-v3-system-console.json"));
  JValue records = loadFixture(QStringLiteral("todo-v2.json"));
  QString maint = QStringLiteral("running");
  // updates.status in the gateway's shape (machined updates.get, or no open job)
  JValue update = JValue::object({{QStringLiteral("updateId"), JValue::null()}, {QStringLiteral("state"), QStringLiteral("none")}});

  JValue appDetail(const QString& appId) const {
    for (const JValue* sc : {&kanban, &console}) {
      const JValue& a = sc->get(QStringLiteral("app"));
      if (a.get(QStringLiteral("appId")).str() == appId)
        return JValue::object({{QStringLiteral("appId"), appId}, {QStringLiteral("appEpoch"), a.get(QStringLiteral("appEpoch"))}, {QStringLiteral("activeRevisionId"), a.get(QStringLiteral("revisionId"))}, {QStringLiteral("bundle"), sc->get(QStringLiteral("bundle"))}});
    }
    return JValue::object({{QStringLiteral("appId"), appId}, {QStringLiteral("appEpoch"), 3}, {QStringLiteral("activeRevisionId"), QStringLiteral("rec-r1")}, {QStringLiteral("bundle"), records}});
  }
  JValue queryOutput(const QString& appId, const QString& queryId) const {
    for (const JValue* sc : {&kanban, &console}) {
      if (sc->get(QStringLiteral("app")).get(QStringLiteral("appId")).str() != appId) continue;
      const JValue& ds = sc->get(QStringLiteral("bundle")).get(QStringLiteral("view")).get(QStringLiteral("dataSources"));
      for (const auto& m : ds.members())
        if (m.second.get(QStringLiteral("queryId")).str() == queryId)
          for (const auto& st : sc->get(QStringLiteral("steps")).items())
            if (st.get(QStringLiteral("op")).str() == QLatin1String("load") && st.get(QStringLiteral("source")).str() == m.first) return decodeMissing(st.get(QStringLiteral("output")));
    }
    return JValue::object();
  }
  static JValue err(const QString& code) {
    return JValue::object({{QStringLiteral("__error"), JValue::object({{QStringLiteral("code"), code}, {QStringLiteral("message"), code}})}});
  }

  JValue handle(const JValue& req) {
    const QString m = req.get(QStringLiteral("methodId")).str();
    const JValue& p = req.get(QStringLiteral("params"));
    const JValue& b = req.get(QStringLiteral("body"));
    if (m == QLatin1String("session.bind") || m == QLatin1String("session.status"))
      return JValue::object({{QStringLiteral("userId"), QStringLiteral("u-alice")}, {QStringLiteral("userName"), QStringLiteral("alice")}, {QStringLiteral("role"), QStringLiteral("owner")}, {QStringLiteral("sessionEpoch"), double(sessionEpoch.load())}, {QStringLiteral("locked"), locked.load()}});
    if (m == QLatin1String("workspaces.list"))
      return JValue::object({{QStringLiteral("items"), JValue::array({JValue::object({{QStringLiteral("workspaceId"), WS_A}, {QStringLiteral("displayName"), QString::fromUtf8("家庭")}, {QStringLiteral("state"), QStringLiteral("running")}, {QStringLiteral("role"), workspaceOwner ? QStringLiteral("owner") : QStringLiteral("editor")}, {QStringLiteral("runWhenLoggedOut"), backgroundEnabled.load()}}),
                                                                      JValue::object({{QStringLiteral("workspaceId"), WS_B}, {QStringLiteral("displayName"), QString::fromUtf8("工作")}, {QStringLiteral("state"), QStringLiteral("running")}})})}});
    if (m == QLatin1String("workspaces.attach"))
      return JValue::object({{QStringLiteral("workspaceId"), p.get(QStringLiteral("workspaceId"))}, {QStringLiteral("clientEpoch"), 2}, {QStringLiteral("storeUUID"), QStringLiteral("store-") + p.get(QStringLiteral("workspaceId")).str().left(4)}, {QStringLiteral("cursor"), 10}});
    if (m == QLatin1String("events.subscribe")) return JValue::object({{QStringLiteral("cursor"), b.get(QStringLiteral("cursor"))}});
    if (m == QLatin1String("events.ack") || m == QLatin1String("members.list") || m == QLatin1String("backups.list")) return JValue::object({{QStringLiteral("items"), JValue::array()}});
    if (m == QLatin1String("machine.status")) {
      if (nativeStatusShape) return JValue::object({{QStringLiteral("meta"), JValue::object({{QStringLiteral("currentReleaseId"), QStringLiteral("1.0.0")}})}});
      return JValue::object({{QStringLiteral("release"), JValue::object({{QStringLiteral("releaseId"), QStringLiteral("1.0.0")}})},
                             {QStringLiteral("components"), JValue::object({{QStringLiteral("host"), hostDown ? QStringLiteral("down") : QStringLiteral("ok")}, {QStringLiteral("model"), modelDown ? QStringLiteral("down") : QStringLiteral("ok")}, {QStringLiteral("broker"), brokerDown ? QStringLiteral("down") : QStringLiteral("ok")}})},
                             {QStringLiteral("setup"), JValue::object({{QStringLiteral("state"), QStringLiteral("done")}, {QStringLiteral("steps"), JValue::array()}})}});
    }
    if (m == QLatin1String("machine.capabilities"))  // the shape machined's capabilities() reports, under `hardware`
      return JValue::object({{QStringLiteral("hardware"), JValue::object({
                                 {QStringLiteral("network"), JValue::object({{QStringLiteral("available"), false}})},
                                 {QStringLiteral("battery"), JValue::object({{QStringLiteral("available"), true}, {QStringLiteral("batteryPresent"), true}, {QStringLiteral("percentage"), 81.6}, {QStringLiteral("onBattery"), true}})},
                                 {QStringLiteral("time"), JValue::object({{QStringLiteral("timezone"), QStringLiteral("UTC")}})},
                                 {QStringLiteral("power"), JValue::object({{QStringLiteral("reboot"), QStringLiteral("yes")}, {QStringLiteral("poweroff"), QStringLiteral("yes")}, {QStringLiteral("suspend"), QStringLiteral("yes")}, {QStringLiteral("hibernate"), QStringLiteral("unsupported")}})}})}});
    if (m == QLatin1String("machine.users.create") || m == QLatin1String("machine.users.disable")) {  // gw.rs: an ops.plan for users.*
      const bool create = m == QLatin1String("machine.users.create");
      if (create && !b.get(QStringLiteral("password")).isString()) return err(QStringLiteral("INVALID_REQUEST"));
      return JValue::object({{QStringLiteral("operationId"), QStringLiteral("op-user")}, {QStringLiteral("planHash"), QStringLiteral("sha256:") + QString(64, QLatin1Char('7'))},
                             {QStringLiteral("state"), QStringLiteral("planned")}, {QStringLiteral("kind"), create ? QStringLiteral("users.create") : QStringLiteral("users.disable")}, {QStringLiteral("admin"), true},
                             {QStringLiteral("resourceId"), create ? QStringLiteral("user:") + b.get(QStringLiteral("loginName")).str() : QStringLiteral("user:") + b.get(QStringLiteral("userId")).str()},
                             {QStringLiteral("resourceGeneration"), 1}});
    }
    if (m == QLatin1String("machine.actions.plan")) {
      plannedBackground = b.get(QStringLiteral("params")).get(QStringLiteral("enabled")).toBool();
      if (lastKind == QLatin1String("admin.update"))  // admin kind: the plan shows the root helper command
        return JValue::object({{QStringLiteral("operationId"), QStringLiteral("op-up")}, {QStringLiteral("planHash"), QStringLiteral("sha256:") + QString(64, QLatin1Char('6'))},
                               {QStringLiteral("state"), QStringLiteral("planned")}, {QStringLiteral("kind"), lastKind}, {QStringLiteral("admin"), true},
                               {QStringLiteral("resourceId"), QStringLiteral("admin.update")}, {QStringLiteral("resourceGeneration"), 1},
                               {QStringLiteral("impact"), JValue::object({{QStringLiteral("command"), QStringLiteral("agentosctl update activate --update-id ") + update.get(QStringLiteral("updateId")).stringOr(QString())}, {QStringLiteral("runsAs"), QStringLiteral("root helper")}})}});
      if (lastKind == QLatin1String("time.timezone.set"))  // the shape machined's ops.plan returns for an admin kind
        return JValue::object({{QStringLiteral("operationId"), QStringLiteral("op-tz")}, {QStringLiteral("planHash"), QStringLiteral("sha256:") + QString(64, QLatin1Char('3'))},
                               {QStringLiteral("state"), QStringLiteral("planned")}, {QStringLiteral("kind"), lastKind}, {QStringLiteral("admin"), true},
                               {QStringLiteral("resourceId"), QStringLiteral("timedate:zone")}, {QStringLiteral("resourceGeneration"), 4},
                               {QStringLiteral("expiresAt"), double(QDateTime::currentMSecsSinceEpoch() + 10 * 60000)},
                               {QStringLiteral("impact"), JValue::object({{QStringLiteral("from"), QStringLiteral("UTC")}, {QStringLiteral("to"), b.get(QStringLiteral("params")).get(QStringLiteral("zone"))}})}});
      if (lastKind == QLatin1String("workspaces.runWhenLoggedOut"))
        return JValue::object({{QStringLiteral("operationId"), QStringLiteral("op-1")}, {QStringLiteral("planHash"), QStringLiteral("sha256:") + QString(64, QLatin1Char('2'))},
                               {QStringLiteral("state"), QStringLiteral("planned")}, {QStringLiteral("kind"), lastKind}, {QStringLiteral("admin"), false},
                               {QStringLiteral("resourceId"), QStringLiteral("workspace:") + WS_A + QStringLiteral(":runWhenLoggedOut")}, {QStringLiteral("resourceGeneration"), 1},
                               {QStringLiteral("impact"), b.get(QStringLiteral("params"))}});
      return JValue::object({{QStringLiteral("operationId"), QStringLiteral("op-1")}, {QStringLiteral("planHash"), QStringLiteral("sha256:") + QString(64, QLatin1Char('2'))}, {QStringLiteral("state"), QStringLiteral("planned")}, {QStringLiteral("ticket"), QStringLiteral("ticket-1")},
                             {QStringLiteral("actionKind"), b.get(QStringLiteral("actionKind"))}, {QStringLiteral("summary"), JValue::object({{QStringLiteral("resource"), b.get(QStringLiteral("actionKind"))}, {QStringLiteral("version"), QStringLiteral("generation 7")}, {QStringLiteral("effect"), b.get(QStringLiteral("params")).stringify()}})}});
    }
    if (m == QLatin1String("machine.actions.confirm")) {
      if (planStale) return err(QStringLiteral("PLAN_STALE"));
      // the gateway refuses an admin plan without the administrator's password (gw.rs confirm, PAM)
      if (lastKind == QLatin1String("time.timezone.set") && b.get(QStringLiteral("password")).str() != QLatin1String("admin-pw-1")) return err(QStringLiteral("SESSION_REQUIRED"));
      if (lastKind == QLatin1String("workspaces.runWhenLoggedOut")) backgroundEnabled = plannedBackground;
      return JValue::object({{QStringLiteral("operationId"), QStringLiteral("op-1")}, {QStringLiteral("state"), QStringLiteral("dispatching")}});
    }
    if (m == QLatin1String("machine.actions.get"))
      return JValue::object({{QStringLiteral("operationId"), QStringLiteral("op-1")}, {QStringLiteral("state"), QStringLiteral("succeeded")}, {QStringLiteral("actionKind"), lastKind}, {QStringLiteral("previous"), JValue::object({{QStringLiteral("output"), QStringLiteral("Virtual-1")}, {QStringLiteral("mode"), QStringLiteral("1280x800")}, {QStringLiteral("scale"), 1}})}});
    if (m == QLatin1String("machine.actions.cancel")) return JValue::object({{QStringLiteral("state"), QStringLiteral("cancelled")}});
    if (m == QLatin1String("updates.status")) return update;
    if (m != QLatin1String("workspace.forward")) return JValue::object();
    const QString route = b.get(QStringLiteral("routeId")).str();
    const JValue& fp = b.get(QStringLiteral("params"));
    if (hostDown) return err(QStringLiteral("HOST_UNAVAILABLE"));
    if (route == QLatin1String("state.list"))
      return JValue::object({{QStringLiteral("modelAvailable"), !modelDown}, {QStringLiteral("brokerReady"), !brokerDown},
                             {QStringLiteral("model"), modelDown ? JValue() : JValue::object({{QStringLiteral("provider"), QStringLiteral("openai-compatible")}, {QStringLiteral("modelId"), QStringLiteral("fake-model-1")}, {QStringLiteral("mode"), QStringLiteral("real")}})},
                             {QStringLiteral("agentDiagnostic"), modelDown ? JValue(QStringLiteral("AGENTOS_MODEL_PROVIDER / AGENTOS_MODEL_ID are not configured")) : JValue()},
                             {QStringLiteral("apps"), JValue::array({
                                 JValue::object({{QStringLiteral("appId"), kanban.get(QStringLiteral("app")).get(QStringLiteral("appId"))}, {QStringLiteral("title"), QString::fromUtf8("待办看板")}, {QStringLiteral("appEpoch"), 3}}),
                                 JValue::object({{QStringLiteral("appId"), console.get(QStringLiteral("app")).get(QStringLiteral("appId"))}, {QStringLiteral("title"), QString::fromUtf8("系统控制台")}, {QStringLiteral("appEpoch"), 3}}),
                                 JValue::object({{QStringLiteral("appId"), QStringLiteral("rec-app")}, {QStringLiteral("title"), QString::fromUtf8("记录")}, {QStringLiteral("appEpoch"), 3}})})}});
    if (route == QLatin1String("apps.get")) return appDetail(fp.get(QStringLiteral("appId")).str());
    if (route == QLatin1String("apps.queries.post")) {
      if (holdQueries) return JValue();  // answered later by the test
      return JValue::object({{QStringLiteral("output"), queryOutput(fp.get(QStringLiteral("appId")).str(), fp.get(QStringLiteral("queryId")).str())}, {QStringLiteral("revisionId"), appDetail(fp.get(QStringLiteral("appId")).str()).get(QStringLiteral("activeRevisionId"))}, {QStringLiteral("appEpoch"), 3}});
    }
    if (route == QLatin1String("apps.records.list")) return holdRecordLists ? JValue() : JValue::object({{QStringLiteral("items"), JValue::array()}, {QStringLiteral("total"), 0}});
    if (route == QLatin1String("apps.records.post")) return JValue::object({{QStringLiteral("id"), QStringLiteral("r-1")}, {QStringLiteral("recordVersion"), 1}});
    if (route == QLatin1String("apps.systemactions.post")) return brokerDown ? err(QStringLiteral("BROKER_UNAVAILABLE")) : JValue::object({{QStringLiteral("actionId"), QStringLiteral("act-1")}, {QStringLiteral("confirmationRequired"), true}});
    if (route == QLatin1String("systemactions.get"))
      return JValue::object({{QStringLiteral("actionId"), QStringLiteral("act-1")}, {QStringLiteral("phase"), QStringLiteral("awaiting_confirmation")}, {QStringLiteral("planHash"), QStringLiteral("sha256:") + QString(64, QLatin1Char('9'))}, {QStringLiteral("handlerId"), QStringLiteral("setCpu")}, {QStringLiteral("resourceId"), QStringLiteral("app:console")}, {QStringLiteral("appEpoch"), 3}});
    if (route == QLatin1String("systemactions.confirm.post")) return JValue::object({{QStringLiteral("actionId"), QStringLiteral("act-1")}, {QStringLiteral("phase"), QStringLiteral("applied")}});
    if (route == QLatin1String("runs.list"))
      return JValue::object({{QStringLiteral("items"), JValue::array({JValue::object({{QStringLiteral("runId"), QStringLiteral("run-1")}, {QStringLiteral("intent"), QString::fromUtf8("做个记账应用")}, {QStringLiteral("status"), QStringLiteral("running")}, {QStringLiteral("conversationId"), QStringLiteral("conv-1")}})})}});
    if (route == QLatin1String("runs.cancel.post")) return JValue::object({{QStringLiteral("runId"), QStringLiteral("run-1")}, {QStringLiteral("status"), QStringLiteral("cancelling")}});
    if (route == QLatin1String("runs.get")) return JValue::object({{QStringLiteral("runId"), QStringLiteral("run-1")}, {QStringLiteral("status"), QStringLiteral("cancelled")}});
    if (route == QLatin1String("runs.post") && forbidRuns) return err(QStringLiteral("NOT_FOUND_OR_FORBIDDEN"));  // the gateway's answer to a viewer
    if (route == QLatin1String("runs.post")) return modelDown ? err(QStringLiteral("MODEL_UNAVAILABLE")) : JValue::object({{QStringLiteral("runId"), QStringLiteral("run-2")}, {QStringLiteral("status"), QStringLiteral("queued")}});
    if (route == QLatin1String("maintenance.state.list")) return JValue::object({{QStringLiteral("state"), maint}, {QStringLiteral("circuits"), JValue::array()}});
    if (route == QLatin1String("maintenance.control.post")) {
      maint = b.get(QStringLiteral("body")).get(QStringLiteral("action")).str() == QLatin1String("pause") ? QStringLiteral("paused") : QStringLiteral("running");
      return JValue::object({{QStringLiteral("state"), maint}});
    }
    if (route == QLatin1String("proposals.list"))
      return JValue::object({{QStringLiteral("items"), JValue::array({JValue::object({{QStringLiteral("proposalId"), QStringLiteral("prop-1")}, {QStringLiteral("state"), QStringLiteral("ready")}, {QStringLiteral("proposalHash"), QStringLiteral("sha256:") + QString(64, QLatin1Char('f'))}, {QStringLiteral("baseAppEpoch"), 3}, {QStringLiteral("label"), QString::fromUtf8("修复看板")}})})}});
    if (route == QLatin1String("proposals.accept.post")) return JValue::object({{QStringLiteral("state"), QStringLiteral("committed")}});
    if (route == QLatin1String("apps.archive.post")) return JValue::object({{QStringLiteral("state"), QStringLiteral("archived")}});
    if (route == QLatin1String("apps.restore.post")) return JValue::object({{QStringLiteral("state"), QStringLiteral("active")}});
    if (route == QLatin1String("conversations.compactions.post")) return JValue::object({{QStringLiteral("compactionId"), QStringLiteral("cmp-1")}, {QStringLiteral("state"), QStringLiteral("completed")}});
    if (route == QLatin1String("notifications.list") && withNotification)  // core health/incidents.ts Notifications.list()
      return JValue::object({{QStringLiteral("items"), JValue::array({JValue::object({{QStringLiteral("id"), QStringLiteral("n-disk")}, {QStringLiteral("kind"), QStringLiteral("disk")}, {QStringLiteral("subject"), QStringLiteral("machine")},
                                                                                     {QStringLiteral("severity"), QStringLiteral("critical")}, {QStringLiteral("title"), QString::fromUtf8("磁盘空间不足")}, {QStringLiteral("detail"), QStringLiteral("5% free")},
                                                                                     {QStringLiteral("count"), 3}, {QStringLiteral("state"), QStringLiteral("open")}, {QStringLiteral("createdAt"), QStringLiteral("2026-11-02T10:00:00Z")}})})}});
    if (route.endsWith(QLatin1String(".list"))) return JValue::object({{QStringLiteral("items"), JValue::array()}});
    return JValue::object();
  }
  QString lastKind = QStringLiteral("power.reboot");
};

struct Harness {
  QTemporaryDir dir;
  Backend be;
  std::unique_ptr<GatewayThread> gw;
  std::unique_ptr<ShellController> shell;
  std::unique_ptr<View> view;
  Harness() {
    gw = std::make_unique<GatewayThread>(dir.path() + QStringLiteral("/gw.sock"));
    gw->gw->setHandler([this](const JValue& r) {
      if (r.get(QStringLiteral("methodId")).str() == QLatin1String("machine.actions.plan")) be.lastKind = r.get(QStringLiteral("body")).get(QStringLiteral("actionKind")).str();
      return be.handle(r);
    });
    shell = std::make_unique<ShellController>(dir.path() + QStringLiteral("/gw.sock"));
    shell->setLayoutDir(dir.path());
    view = std::make_unique<View>(shell.get(), QSize(1280, 900));
  }
  bool up() {
    if (!view->load(QStringLiteral("ShellRoot.qml"))) return false;
    shell->start();
    return QTest::qWaitFor([&] { return shell->sessionBound() && shell->workspaceId() == WS_A && static_cast<CanvasModel*>(shell->canvas())->count() == 3; }, 8000);
  }
  QVector<JValue> sent(const QString& methodOrRoute) const {
    QVector<JValue> out;
    for (const auto& r : gw->gw->requests())
      if (r.get(QStringLiteral("methodId")).str() == methodOrRoute || r.get(QStringLiteral("body")).get(QStringLiteral("routeId")).str() == methodOrRoute) out << r;
    return out;
  }
  QQuickItem* find(const QString& n) const { return findByObjectName(view->root(), n); }
  void click(const QString& n) {
    QQuickItem* b = find(n);
    if (n.startsWith(QLatin1String("nav:")) && n != QLatin1String("nav:settings") && (!b || !reallyVisible(b))) {
      QQuickItem* settings = find(QStringLiteral("nav:settings"));
      QVERIFY2(settings, "nav:settings");
      QMetaObject::invokeMethod(settings, "clicked");
      QTRY_VERIFY2(find(n) && reallyVisible(find(n)), qPrintable(n));
      b = find(n);
    }
    QVERIFY2(b, qPrintable(n));
    QVERIFY2(b->isEnabled(), qPrintable(n + QStringLiteral(" disabled")));
    QMetaObject::invokeMethod(b, "clicked");
  }
  QString actionState(const QString& name) const {
    auto* a = static_cast<ActionTracker*>(shell->actions());
    for (int i = 0; i < a->count(); ++i)
      if (a->at(i).get(QStringLiteral("name")).str() == name) return a->at(i).get(QStringLiteral("state")).str();
    return {};
  }
};

class FlowsTest : public QObject {
  Q_OBJECT
 private slots:
  void initTestCase() {
    prepareQmlEnvironment();
    QQuickStyle::setStyle(QStringLiteral("Basic"));
    g_prev = qInstallMessageHandler(captureQml);
  }
  void cleanupTestCase() {
    // fixed QML must run warning-free through every flow (no undefined bindings, no failed loads)
    QVERIFY2(g_qmlWarnings.isEmpty(), qPrintable(g_qmlWarnings.mid(0, 10).join(QLatin1Char('\n'))));
  }

  void everyPageRendersFromTheGateway() {
    Harness h;
    QVERIFY(h.up());
    QCOMPARE(h.shell->userName(), QStringLiteral("alice"));
    // every request carried the scope fields; business calls only through workspace.forward
    for (const auto& r : h.gw->gw->requests()) {
      for (const char* k : {"requestId", "workspaceId", "clientEpoch", "sessionEpoch", "methodId", "params", "body"}) QVERIFY2(r.has(QString::fromLatin1(k)), k);
      if (r.get(QStringLiteral("methodId")).str() == QLatin1String("workspace.forward")) {
        for (const char* bad : {"url", "path", "method", "header", "headers", "principal", "socket", "userId", "executionUid"}) QVERIFY(!r.get(QStringLiteral("body")).has(QString::fromLatin1(bad)));
        QVERIFY(!r.get(QStringLiteral("idempotencyKey")).str().isEmpty());
      }
    }
    for (const QString& p : {QStringLiteral("home"), QStringLiteral("model"), QStringLiteral("login"), QStringLiteral("workspaces"), QStringLiteral("tasks"), QStringLiteral("policies"), QStringLiteral("incidents"),
                             QStringLiteral("proposals"), QStringLiteral("diagnostics"), QStringLiteral("backup"), QStringLiteral("update"), QStringLiteral("hardware")}) {
      h.click(QStringLiteral("nav:") + p);
      QTRY_COMPARE(h.shell->currentPage(), p);
      QTest::qWait(250);
      QImage img = h.view->shot(QStringLiteral("page-") + p + QStringLiteral(".png"));
      QVERIFY2(imageLooksRendered(img), qPrintable(p));
    }
    // hardware without a backend capability says so instead of pretending
    bool unavailableShown = false;
    for (QQuickItem* t : itemsOfClass(h.view->root(), "QQuickText"))
      if (reallyVisible(t) && t->property("text").toString().startsWith(QString::fromUtf8("不可用"))) unavailableShown = true;
    QVERIFY(unavailableShown);
    // home canvas: expand a code app; it renders inside its card
    h.click(QStringLiteral("nav:home"));
    h.shell->expandCard(h.be.kanban.get(QStringLiteral("app")).get(QStringLiteral("appId")).str(), true);
    QTRY_VERIFY_WITH_TIMEOUT(itemsOfClass(h.view->root(), "QQuickTextField").size() >= 2, 5000);
    QTest::qWait(300);
    QVERIFY(imageLooksRendered(h.view->shot(QStringLiteral("page-home-expanded.png"))));
    h.shell->openApp(QStringLiteral("rec-app"));
    QTRY_COMPARE(h.shell->currentPage(), QStringLiteral("app"));
    QTest::qWait(300);
    QVERIFY(imageLooksRendered(h.view->shot(QStringLiteral("page-app-records.png"))));
    QVERIFY2(g_qmlWarnings.isEmpty(), qPrintable(g_qmlWarnings.join(QLatin1Char('\n'))));
  }

  // m20 run 41996575284: PageFrame's ScrollView reported contentHeight -1, so real wheel input never moved
  // the app detail page and its version section stayed below the fold. A short viewport forces overflow.
  void appDetailPageScrollsToItsVersionSectionWithRealWheel() {
    Harness h;
    h.view = std::make_unique<View>(h.shell.get(), QSize(1280, 420));
    QVERIFY(h.up());
    h.shell->openApp(QStringLiteral("rec-app"));
    QTRY_COMPARE(h.shell->currentPage(), QStringLiteral("app"));
    QTest::qWait(300);
    QQuickItem* scroll = h.find(QStringLiteral("pageScroll"));
    QVERIFY(scroll && reallyVisible(scroll));
    QObject* flick = scroll->property("contentItem").value<QObject*>();
    QVERIFY(flick);
    QQuickItem* heading = nullptr;
    for (QQuickItem* t : itemsOfClass(h.view->root(), "QQuickText"))
      if (!heading && reallyVisible(t) && t->property("text").toString() == QString::fromUtf8("版本")) heading = t;
    QVERIFY(heading);
    const double viewport = flick->property("height").toDouble();
    QTRY_VERIFY2(flick->property("contentHeight").toDouble() > viewport,
                 qPrintable(QStringLiteral("contentHeight %1 viewport %2").arg(flick->property("contentHeight").toDouble()).arg(viewport)));
    const QRectF area = scroll->mapRectToScene(scroll->boundingRect());
    const QPointF at(area.right() - 24, area.center().y());
    const QRectF window(0, 0, h.view->view.width(), h.view->view.height());
    for (int n = 0; n < 40 && !window.contains(heading->mapRectToScene(heading->boundingRect())); ++n) {
      QWheelEvent wheel(at, h.view->view.mapToGlobal(at), QPoint(), QPoint(0, -120), Qt::NoButton, Qt::NoModifier, Qt::NoScrollPhase, false);
      wheel.setTimestamp(ulong(1000 + 100 * n));  // a real device stamps each notch; unstamped repeats stalled Flickable at contentY 72 here
      QGuiApplication::sendEvent(&h.view->view, &wheel);
      QTest::qWait(60);
    }
    QTRY_VERIFY2(window.contains(heading->mapRectToScene(heading->boundingRect())),
                 qPrintable(QStringLiteral("contentY %1 contentHeight %2 viewport %3 heading %4,%5")
                               .arg(flick->property("contentY").toDouble()).arg(flick->property("contentHeight").toDouble()).arg(viewport)
                               .arg(heading->mapRectToScene(heading->boundingRect()).x()).arg(heading->mapRectToScene(heading->boundingRect()).y())));
    QVERIFY(flick->property("contentY").toDouble() > 0);
    QVERIFY2(g_qmlWarnings.isEmpty(), qPrintable(g_qmlWarnings.join(QLatin1Char('\n'))));
  }

  void softwareViewportKeepsNavigationAndLongAdminPlansReachable() {
    Harness h;
    h.view = std::make_unique<View>(h.shell.get(), QSize(1280, 800));
    QVERIFY(h.up());
    h.view->view.requestActivate();
    // A model outage and a notice occupy both status strips; every nav item must still fit.
    h.be.modelDown = true;
    h.shell->refreshPage();
    QTRY_VERIFY(!h.shell->modelAvailable());
    h.shell->submitIntent(QStringLiteral("viewport outage check"), QString());
    QVERIFY(!h.shell->notice().isEmpty());
    const QRectF viewport(0, 0, 1280, 800);
    const auto reachable = [&](const char* page) {
      QQuickItem* nav = h.find(QStringLiteral("nav:") + QString::fromLatin1(page));
      QVERIFY2(nav && reallyVisible(nav), page);
      QVERIFY2(viewport.contains(nav->mapRectToScene(nav->boundingRect())), page);
      for (QQuickItem* parent = nav->parentItem(); parent; parent = parent->parentItem())
        if (parent->clip()) QVERIFY2(parent->boundingRect().contains(nav->mapRectToItem(parent, nav->boundingRect())), page);
    };
    for (const char* page : {"home", "app", "tasks", "settings"}) reachable(page);
    h.click(QStringLiteral("nav:settings"));
    QTRY_VERIFY(h.find(QStringLiteral("settings")));
    for (const char* page : {"model", "login", "workspaces", "policies", "incidents", "proposals", "diagnostics", "backup", "update", "hardware"}) {
      QQuickItem* nav = h.find(QStringLiteral("nav:") + QString::fromLatin1(page));
      QVERIFY(nav && reallyVisible(nav));
      QVERIFY2(viewport.contains(nav->mapRectToScene(nav->boundingRect())), page);
      for (QQuickItem* parent = nav->parentItem(); parent; parent = parent->parentItem())
        if (parent->clip()) QVERIFY2(parent->boundingRect().contains(nav->mapRectToItem(parent, nav->boundingRect())), page);
    }
    bool rejected = false;
    h.shell->showPlanForTest(QStringLiteral("machine.plan"), JValue::object({
      {QStringLiteral("kind"), QStringLiteral("time.timezone.set")}, {QStringLiteral("admin"), true},
      {QStringLiteral("planHash"), QStringLiteral("sha256:") + QString(64, QLatin1Char('a'))},
      {QStringLiteral("effect"), QString(8000, QLatin1Char('x'))}
    }), [&](bool yes) { rejected = !yes; });
    QQuickItem* no = h.find(QStringLiteral("confirmReject"));
    QQuickItem* ok = h.find(QStringLiteral("confirmAccept"));
    QQuickItem* password = h.find(QStringLiteral("confirmAdminPassword"));
    QVERIFY(no && ok && password);
    QTRY_COMPARE(h.view->view.activeFocusItem(), no);
    QTest::keyClick(&h.view->view, Qt::Key_Tab);
    QTRY_COMPARE(h.view->view.activeFocusItem(), password);
    for (QQuickItem* item : {no, ok, password}) {
      QVERIFY(reallyVisible(item));
      QVERIFY(viewport.contains(item->mapRectToScene(item->boundingRect())));
    }
    QVERIFY(!ok->isEnabled());
    password->setProperty("text", QStringLiteral("one-time-test-password"));
    QVERIFY(ok->isEnabled());
    password->forceActiveFocus();
    QTest::keyClick(&h.view->view, Qt::Key_Return);
    QVERIFY(h.shell->confirm().value(QStringLiteral("visible")).toBool());
    ok->forceActiveFocus();
    QTest::keyClick(&h.view->view, Qt::Key_Return);
    QTest::keyClick(&h.view->view, Qt::Key_Enter);
    QVERIFY(h.shell->confirm().value(QStringLiteral("visible")).toBool());
    QCOMPARE(h.sent(QStringLiteral("machine.actions.confirm")).size(), 0);
    QVERIFY(imageLooksRendered(h.view->shot(QStringLiteral("trusted-long-plan-1280x800.png"))));
    no->forceActiveFocus();
    QTest::keyClick(&h.view->view, Qt::Key_Return);
    QTRY_VERIFY(rejected);
    QVERIFY(password->property("text").toString().isEmpty());
  }

  void canvasLayoutKeepsOnlyPositionsAndPrefs() {
    Harness h;
    QVERIFY(h.up());
    auto* c = static_cast<CanvasModel*>(h.shell->canvas());
    const QString kan = h.be.kanban.get(QStringLiteral("app")).get(QStringLiteral("appId")).str();
    QVERIFY(c->setExpanded(kan, true));
    c->move(kan, 2, 1);
    c->setPinned(kan, true);
    h.shell->saveLayout();
    QFile f(h.shell->layoutFile());
    QVERIFY(f.open(QIODevice::ReadOnly));
    JValue saved = parseJsonOrThrow(f.readAll());
    QStringList top = saved.keys();
    top.sort();
    QCOMPARE(top, (QStringList{QStringLiteral("cards"), QStringLiteral("prefsVersion")}));
    for (const auto& card : saved.get(QStringLiteral("cards")).items()) {
      QStringList k = card.keys();
      k.sort();
      QCOMPARE(k, (QStringList{QStringLiteral("appId"), QStringLiteral("h"), QStringLiteral("prefs"), QStringLiteral("w"), QStringLiteral("x"), QStringLiteral("y")}));
      QStringList pk = card.get(QStringLiteral("prefs")).keys();
      pk.sort();
      QCOMPARE(pk, (QStringList{QStringLiteral("expanded"), QStringLiteral("pinned")}));
    }
    QVERIFY(!saved.stringify().contains(QString::fromUtf8("待办")));  // no app titles/content
    // at most 4 expanded at once; further expansions are refused (the pinned, expanded card stays and counts)
    QList<QPair<QString, QString>> apps;
    for (int i = 0; i < 6; ++i) apps << qMakePair(QStringLiteral("app-%1").arg(i), QStringLiteral("t"));
    c->setApps(apps);
    QCOMPARE(c->expandedCount(), 1);
    int ok = 0;
    for (int i = 0; i < 6; ++i) ok += c->setExpanded(QStringLiteral("app-%1").arg(i), true) ? 1 : 0;
    QCOMPARE(ok, 3);
    QCOMPARE(c->expandedCount(), CanvasModel::kMaxExpanded);
    // restore from disk
    CanvasModel back;
    QVERIFY(back.load(h.shell->layoutFile()));
    QCOMPARE(back.cards().front().appId, kan);
  }

  void dailyActionsReachReconciledState() {
    Harness h;
    QVERIFY(h.up());
    h.click(QStringLiteral("nav:tasks"));
    QTRY_VERIFY(h.find(QStringLiteral("cancelRun")) && h.find(QStringLiteral("cancelRun"))->isEnabled());
    h.click(QStringLiteral("cancelRun"));
    QTRY_COMPARE_WITH_TIMEOUT(h.actionState(QStringLiteral("runs.cancel")), QStringLiteral("reconciled"), 5000);
    QCOMPARE(h.sent(QStringLiteral("runs.cancel.post")).size(), 1);
    QVERIFY(h.sent(QStringLiteral("runs.get")).size() >= 1);  // reconciled from the authoritative status
    h.click(QStringLiteral("compact"));
    QTRY_COMPARE(h.actionState(QStringLiteral("conversation.compact")), QStringLiteral("reconciled"));
    h.click(QStringLiteral("nav:policies"));
    QTRY_VERIFY(h.find(QStringLiteral("maintToggle")));
    // a red danger button asks once more: 取消 sends nothing, 确定 sends exactly one request
    const int pausesBefore = h.sent(QStringLiteral("maintenance.control.post")).size();
    h.view->view.requestActivate();
    h.click(QStringLiteral("maintToggle"));
    QTRY_VERIFY(reallyVisible(h.find(QStringLiteral("dangerSure"))));
    QVERIFY(h.find(QStringLiteral("dangerSureText"))->property("text").toString().contains(QString::fromUtf8("暂停全部自动维护")));
    QTRY_COMPARE(h.view->view.activeFocusItem(), h.find(QStringLiteral("dangerSureCancel")));
    QVERIFY(imageLooksRendered(h.view->shot(QStringLiteral("danger-sure.png"))));
    h.click(QStringLiteral("dangerSureCancel"));
    QTRY_VERIFY(!h.find(QStringLiteral("dangerSure"))->isVisible());
    QTest::qWait(100);
    QCOMPARE(h.sent(QStringLiteral("maintenance.control.post")).size(), pausesBefore);
    h.click(QStringLiteral("maintToggle"));
    QTRY_VERIFY(reallyVisible(h.find(QStringLiteral("dangerSure"))));
    h.click(QStringLiteral("dangerSureAccept"));
    QTRY_COMPARE(h.actionState(QStringLiteral("maintenance.pause")), QStringLiteral("reconciled"));
    QCOMPARE(h.sent(QStringLiteral("maintenance.control.post")).size(), pausesBefore + 1);
    QTRY_COMPARE(h.shell->maintenanceState().value(QStringLiteral("state")).toString(), QStringLiteral("paused"));
    h.click(QStringLiteral("nav:proposals"));
    QTRY_VERIFY(h.find(QStringLiteral("acceptProposal")));
    h.click(QStringLiteral("acceptProposal"));
    QTRY_COMPARE(h.actionState(QStringLiteral("proposal.accept")), QStringLiteral("reconciled"));
    QCOMPARE(h.sent(QStringLiteral("proposals.accept.post")).first().get(QStringLiteral("body")).get(QStringLiteral("body")).get(QStringLiteral("proposalHash")).str(), QStringLiteral("sha256:") + QString(64, QLatin1Char('f')));
    h.shell->act(QStringLiteral("app.archive"), {{QStringLiteral("appId"), QStringLiteral("rec-app")}, {QStringLiteral("appEpoch"), 3}});
    h.shell->act(QStringLiteral("app.restore"), {{QStringLiteral("appId"), QStringLiteral("rec-app")}});
    QTRY_COMPARE(h.actionState(QStringLiteral("app.archive")), QStringLiteral("reconciled"));
    QTRY_COMPARE(h.actionState(QStringLiteral("app.restore")), QStringLiteral("reconciled"));
    // each write had its own idempotency key
    QSet<QString> keys;
    for (const char* r : {"runs.cancel.post", "maintenance.control.post", "proposals.accept.post", "apps.archive.post", "apps.restore.post", "conversations.compactions.post"})
      for (const auto& x : h.sent(QString::fromLatin1(r))) keys.insert(x.get(QStringLiteral("idempotencyKey")).str());
    QCOMPARE(keys.size(), 6);
  }

  void machinePlanGoesThroughTrustedConfirmation() {
    Harness h;
    QVERIFY(h.up());
    h.click(QStringLiteral("nav:hardware"));
    h.shell->hardware(QStringLiteral("power.reboot"), {});
    QTRY_VERIFY(h.shell->confirm().value(QStringLiteral("visible")).toBool());
    const QVariantMap c = h.shell->confirm();
    QCOMPARE(c.value(QStringLiteral("planHash")).toString(), QStringLiteral("sha256:") + QString(64, QLatin1Char('2')));
    QVERIFY(c.value(QStringLiteral("user")).toString().contains(QStringLiteral("alice")));
    QCOMPARE(c.value(QStringLiteral("workspace")).toString(), QString::fromUtf8("家庭"));
    QCOMPARE(c.value(QStringLiteral("version")).toString(), QStringLiteral("generation 7"));
    QVERIFY(!c.value(QStringLiteral("permissionChange")).toString().isEmpty());
    QVERIFY(!c.value(QStringLiteral("unknownNote")).toString().isEmpty());
    QCOMPARE(h.actionState(QStringLiteral("machine.plan")), QStringLiteral("needs_confirmation"));
    QCOMPARE(h.sent(QStringLiteral("machine.actions.confirm")).size(), 0);  // nothing runs before the user confirms
    QVERIFY(imageLooksRendered(h.view->shot(QStringLiteral("trusted-confirm-machine.png"))));
    h.click(QStringLiteral("confirmAccept"));
    QTRY_COMPARE(h.sent(QStringLiteral("machine.actions.confirm")).size(), 1);
    const JValue conf = h.sent(QStringLiteral("machine.actions.confirm")).first();
    QCOMPARE(conf.get(QStringLiteral("body")).get(QStringLiteral("planHash")).str(), c.value(QStringLiteral("planHash")).toString());
    QCOMPARE(conf.get(QStringLiteral("body")).get(QStringLiteral("ticket")).str(), QStringLiteral("ticket-1"));
    QTRY_COMPARE(h.actionState(QStringLiteral("machine.confirm")), QStringLiteral("reconciled"));
    // a confirmation shown under an older session epoch is never sent
    h.shell->hardware(QStringLiteral("power.poweroff"), {});
    QTRY_COMPARE(h.sent(QStringLiteral("machine.actions.plan")).last().get(QStringLiteral("body")).get(QStringLiteral("actionKind")).str(), QStringLiteral("power.poweroff"));
    QTRY_VERIFY(h.shell->confirm().value(QStringLiteral("visible")).toBool());
    const int confirmsBefore = h.sent(QStringLiteral("machine.actions.confirm")).size();
    h.be.sessionEpoch = 2;
    h.shell->applyStatusForTest(JValue::object({{QStringLiteral("sessionEpoch"), 2}, {QStringLiteral("locked"), false}}));
    QVERIFY(!h.shell->confirm().value(QStringLiteral("visible")).toBool());
    QTest::qWait(200);
    QCOMPARE(h.sent(QStringLiteral("machine.actions.confirm")).size(), confirmsBefore);
    // the gateway refusing a stale plan: shown as failed, no automatic re-plan
    QTRY_VERIFY_WITH_TIMEOUT(h.shell->sessionBound() && !h.shell->locked(), 5000);
    h.be.planStale = true;
    const int plansBefore = h.sent(QStringLiteral("machine.actions.plan")).size();
    h.shell->hardware(QStringLiteral("power.reboot"), {});
    QTRY_VERIFY(h.shell->confirm().value(QStringLiteral("visible")).toBool());
    h.shell->confirmAccept();
    QTRY_COMPARE(h.actionState(QStringLiteral("machine.confirm")), QStringLiteral("failed"));
    QTest::qWait(300);
    QCOMPARE(h.sent(QStringLiteral("machine.actions.plan")).size(), plansBefore + 1);
  }

  void sameWorkspaceRebindRestoresAnAuthenticatedEventSubscription() {
    std::atomic<int> bound{0}, subscribed{0};
    Harness h;
    h.gw->gw->setHandler([&](const JValue& r) {
      const int conn = h.gw->gw->connections();
      const QString method = r.get(QStringLiteral("methodId")).str();
      if (method == QLatin1String("session.bind")) bound = conn;
      else if (bound != conn) return Backend::err(QStringLiteral("SESSION_REQUIRED"));
      if (method == QLatin1String("events.subscribe")) subscribed = conn;
      return h.be.handle(r);
    });
    QVERIFY(h.up());
    QTRY_COMPARE(subscribed.load(), 1);
    h.shell->setIntentDraft(QStringLiteral("keep the same-session draft"));
    QGuiApplication::clipboard()->setText(QStringLiteral("same session"));
    QSignalSpy events(h.shell->rpc(), &RpcClient::eventReceived);
    QMetaObject::invokeMethod(h.gw->gw, "dropConnection", Qt::BlockingQueuedConnection);
    QTRY_VERIFY_WITH_TIMEOUT(subscribed.load() >= 2, 5000);
    QCOMPARE(h.shell->workspaceId(), WS_A);
    QCOMPARE(h.shell->intentDraft(), QStringLiteral("keep the same-session draft"));
    QCOMPARE(QGuiApplication::clipboard()->text(), QStringLiteral("same session"));
    QMetaObject::invokeMethod(h.gw->gw, "sendEvent", Qt::BlockingQueuedConnection, Q_ARG(QString, WS_A), Q_ARG(qint64, 11),
                              Q_ARG(QString, QStringLiteral("workspace.state_changed")), Q_ARG(agentos::JValue, JValue::object()));
    QTRY_VERIFY(!events.isEmpty());
  }

  void rebindObservesALockThatHappenedWhileDisconnected() {
    Harness h;
    QVERIFY(h.up());
    h.gw->gw->setHandler([&](const JValue& r) {
      if (r.get(QStringLiteral("methodId")).str() == QLatin1String("session.status")) return JValue::missing();
      return h.be.handle(r);  // isolate bind metadata from the periodic status poll
    });
    h.shell->setIntentDraft(QStringLiteral("must disappear on remote lock"));
    QGuiApplication::clipboard()->setText(QStringLiteral("private clipboard"));
    bool rejected = false;
    h.shell->askAppConfirm(QStringLiteral("old plan"), QStringLiteral("not across a lock"), [&](bool yes) { rejected = !yes; });
    h.be.sessionEpoch = 2;
    h.be.locked = true;
    QMetaObject::invokeMethod(h.gw->gw, "dropConnection", Qt::BlockingQueuedConnection);
    QTRY_VERIFY_WITH_TIMEOUT(h.shell->locked() && h.shell->sessionEpoch() == 2, 5000);
    QVERIFY(h.shell->intentDraft().isEmpty());
    QVERIFY(QGuiApplication::clipboard()->text().isEmpty());
    QVERIFY(rejected);
    QVERIFY(!h.shell->confirm().value(QStringLiteral("visible")).toBool());
    QVERIFY(!h.shell->appConfirm().value(QStringLiteral("visible")).toBool());
  }

  void rebindObservesALockUnlockEpochWhileDisconnected() {
    Harness h;
    QVERIFY(h.up());
    h.gw->gw->setHandler([&](const JValue& r) {
      if (r.get(QStringLiteral("methodId")).str() == QLatin1String("session.status")) return JValue::missing();
      return h.be.handle(r);
    });
    h.shell->setIntentDraft(QStringLiteral("old-epoch draft"));
    QGuiApplication::clipboard()->setText(QStringLiteral("old-epoch clipboard"));
    h.be.sessionEpoch = 2;
    QMetaObject::invokeMethod(h.gw->gw, "dropConnection", Qt::BlockingQueuedConnection);
    QTRY_VERIFY_WITH_TIMEOUT(h.shell->sessionEpoch() == 2, 5000);
    QVERIFY(!h.shell->locked());
    QVERIFY(h.shell->intentDraft().isEmpty());
    QVERIFY(QGuiApplication::clipboard()->text().isEmpty());
  }

  void backgroundPolicyUsesTheRealOwnerActionAndTrustedLayer() {
    Harness h;
    QVERIFY(h.up());
    h.click(QStringLiteral("nav:workspaces"));
    QTRY_VERIFY(h.find(QStringLiteral("backgroundPolicy")));
    QQuickItem* policy = h.find(QStringLiteral("backgroundPolicy"));
    QVERIFY(reallyVisible(policy));
    QVERIFY(policy->isEnabled());
    QCOMPARE(policy->property("label").toString(), QStringLiteral("允许注销后运行"));
    h.click(QStringLiteral("backgroundPolicy"));
    QTRY_VERIFY(h.shell->confirm().value(QStringLiteral("visible")).toBool());
    QCOMPARE(h.shell->confirm().value(QStringLiteral("title")).toString(), QStringLiteral("workspaces.runWhenLoggedOut"));
    QCOMPARE(h.shell->confirm().value(QStringLiteral("version")).toString(), QStringLiteral("1"));
    const JValue sent = h.sent(QStringLiteral("machine.actions.plan")).last().get(QStringLiteral("body"));
    QCOMPARE(sent.get(QStringLiteral("actionKind")).str(), QStringLiteral("workspaces.runWhenLoggedOut"));
    QCOMPARE(sent.get(QStringLiteral("params")).get(QStringLiteral("workspaceId")).str(), WS_A);
    QVERIFY(sent.get(QStringLiteral("params")).get(QStringLiteral("enabled")).toBool());
    QVERIFY(!h.be.backgroundEnabled);
    h.click(QStringLiteral("confirmAccept"));
    QTRY_COMPARE(h.actionState(QStringLiteral("machine.confirm")), QStringLiteral("reconciled"));
    QTRY_VERIFY(h.find(QStringLiteral("backgroundPolicy")) && h.find(QStringLiteral("backgroundPolicy"))->property("label").toString() == QStringLiteral("停用后台运行"));
    QVERIFY(h.be.backgroundEnabled);
    h.be.workspaceOwner = false;
    h.shell->refreshPage();
    QTRY_VERIFY(h.find(QStringLiteral("backgroundPolicy")) && !h.find(QStringLiteral("backgroundPolicy"))->isEnabled());
    h.be.workspaceOwner = true;
    h.shell->refreshPage();
    QTRY_VERIFY(h.find(QStringLiteral("backgroundPolicy")) && h.find(QStringLiteral("backgroundPolicy"))->isEnabled());
    h.click(QStringLiteral("backgroundPolicy"));
    QTRY_VERIFY(h.shell->confirm().value(QStringLiteral("visible")).toBool());
    const int n = h.sent(QStringLiteral("machine.actions.confirm")).size();
    h.shell->onLocked();
    QVERIFY(!h.shell->confirm().value(QStringLiteral("visible")).toBool());
    h.shell->confirmAccept();
    QTest::qWait(200);
    QCOMPARE(h.sent(QStringLiteral("machine.actions.confirm")).size(), n);
    QVERIFY(h.be.backgroundEnabled);
  }

  void wifiKeyTravelsOnlyInTheSecretFieldOfOnePlan() {
    // V1-I11: the Wi-Fi key is in the plan request's `secret` field only — not in params, not in what the Shell keeps
    Harness h;
    QVERIFY(h.up());
    const int before = h.sent(QStringLiteral("machine.actions.plan")).size();
    const QString key = QStringLiteral("wifi-key-7f3a91");
    h.shell->hardwareSecret(QStringLiteral("network.wifi.connect"), {{QStringLiteral("device"), QStringLiteral("wlan0")}, {QStringLiteral("ssid"), QStringLiteral("lab")}}, key);
    QTRY_COMPARE(h.sent(QStringLiteral("machine.actions.plan")).size(), before + 1);
    const JValue req = h.sent(QStringLiteral("machine.actions.plan")).last();
    QCOMPARE(req.get(QStringLiteral("body")).get(QStringLiteral("secret")).str(), key);
    QCOMPARE(req.get(QStringLiteral("body")).get(QStringLiteral("actionKind")).str(), QStringLiteral("network.wifi.connect"));
    QVERIFY(!req.get(QStringLiteral("body")).get(QStringLiteral("params")).stringify().contains(key));
    QVERIFY(!h.shell->lastPlanSentForTest().contains(key));
    // a retry of the same action never re-sends the key (it was not kept)
    QTRY_VERIFY(h.shell->confirm().value(QStringLiteral("visible")).toBool());
    for (const auto& v : h.shell->confirm()) QVERIFY(!v.toString().contains(key));
    h.shell->confirmReject();
    // a plain hardware() call carries no secret field
    h.shell->hardware(QStringLiteral("network.wifi.disconnect"), {{QStringLiteral("device"), QStringLiteral("wlan0")}});
    QTRY_COMPARE(h.sent(QStringLiteral("machine.actions.plan")).size(), before + 2);
    QVERIFY(h.sent(QStringLiteral("machine.actions.plan")).last().get(QStringLiteral("body")).get(QStringLiteral("secret")).isNullish());
  }

  void modelPageConnectsAModelWithTheKeyOnlyInTheSecretField() {
    // The model page: shows what the Host runs, and connects a model through workspaces.modelCredential.set with the
    // key only in the plan's secret field (never params, never kept, the field emptied), as the owner only.
    Harness h;
    QVERIFY(h.up());
    h.click(QStringLiteral("nav:model"));
    QTRY_COMPARE(h.shell->currentPage(), QStringLiteral("model"));
    QTRY_COMPARE(h.shell->modelInfo().value(QStringLiteral("modelId")).toString(), QStringLiteral("fake-model-1"));
    QTRY_COMPARE(h.find(QStringLiteral("modelCurrentId"))->property("text").toString(), QStringLiteral("fake-model-1"));
    QQuickItem* url = h.find(QStringLiteral("modelBaseUrl"));
    QQuickItem* id = h.find(QStringLiteral("modelIdField"));
    QQuickItem* key = h.find(QStringLiteral("modelApiKey"));
    QQuickItem* save = h.find(QStringLiteral("modelSave"));
    QVERIFY(url && id && key && save);
    QCOMPARE(id->property("text").toString(), QStringLiteral("fake-model-1"));   // prefilled from what runs
    QCOMPARE(key->property("echoMode").toInt(), 2);  // TextInput.Password
    QVERIFY(!save->isEnabled());
    url->setProperty("text", QStringLiteral("not a url"));
    key->setProperty("text", QStringLiteral("sk-model-5e1d77"));
    QTRY_VERIFY(h.find(QStringLiteral("modelFormHint"))->isVisible());
    QVERIFY(!save->isEnabled());
    url->setProperty("text", QStringLiteral("https://llm.example.test/v1"));
    id->setProperty("text", QStringLiteral("qwen3.8-flash"));
    QTRY_VERIFY(save->isEnabled());
    QVERIFY(imageLooksRendered(h.view->shot(QStringLiteral("page-model-filled.png"))));
    const int before = h.sent(QStringLiteral("machine.actions.plan")).size();
    h.click(QStringLiteral("modelSave"));
    QTRY_VERIFY2(h.sent(QStringLiteral("machine.actions.plan")).size() == before + 1, qPrintable(h.shell->notice()));
    const JValue req = h.sent(QStringLiteral("machine.actions.plan")).last();
    const JValue& body = req.get(QStringLiteral("body"));
    QCOMPARE(body.get(QStringLiteral("actionKind")).str(), QStringLiteral("workspaces.modelCredential.set"));
    QCOMPARE(body.get(QStringLiteral("secret")).str(), QStringLiteral("sk-model-5e1d77"));
    const JValue& params = body.get(QStringLiteral("params"));
    QCOMPARE(params.get(QStringLiteral("workspaceId")).str(), h.shell->workspaceId());
    QCOMPARE(params.get(QStringLiteral("provider")).str(), QStringLiteral("openai-compatible"));
    QCOMPARE(params.get(QStringLiteral("modelId")).str(), QStringLiteral("qwen3.8-flash"));
    QCOMPARE(params.get(QStringLiteral("baseUrl")).str(), QStringLiteral("https://llm.example.test/v1"));
    QVERIFY(!params.stringify().contains(QStringLiteral("sk-model")));
    QVERIFY(!h.shell->lastPlanSentForTest().contains(QStringLiteral("sk-model")));
    QVERIFY(key->property("text").toString().isEmpty());
    QTRY_VERIFY(h.shell->confirm().value(QStringLiteral("visible")).toBool());
    for (const auto& v : h.shell->confirm()) QVERIFY(!v.toString().contains(QStringLiteral("sk-model")));
    h.shell->confirmReject();
    QVERIFY2(g_qmlWarnings.isEmpty(), qPrintable(g_qmlWarnings.join(QLatin1Char('\n'))));
  }

  void modelMissingIsSaidOnTheDesktopWithTheWayToConnect() {
    Harness h;
    h.be.modelDown = true;
    QVERIFY(h.up());
    h.click(QStringLiteral("nav:home"));
    QTRY_VERIFY(!h.shell->modelAvailable());
    QTRY_VERIFY(h.find(QStringLiteral("configureModel")) && reallyVisible(h.find(QStringLiteral("configureModel"))));
    QVERIFY(!h.find(QStringLiteral("intentSubmit"))->isEnabled());
    QVERIFY(reallyVisible(h.find(QStringLiteral("healthChip"))));
    h.click(QStringLiteral("configureModel"));
    QTRY_COMPARE(h.shell->currentPage(), QStringLiteral("model"));
    QTRY_VERIFY(h.find(QStringLiteral("modelState")));
    QCOMPARE(h.find(QStringLiteral("modelState"))->property("text").toString(), QString::fromUtf8("未连接"));
    QVERIFY(imageLooksRendered(h.view->shot(QStringLiteral("page-model-missing.png"))));
  }

  void controlCenterSwitchesToDarkAndBackWithoutWarnings() {
    Harness h;
    h.view = std::make_unique<View>(h.shell.get(), QSize(1280, 800));
    QVERIFY(h.up());
    h.click(QStringLiteral("controlCenterButton"));
    QTRY_VERIFY(reallyVisible(h.find(QStringLiteral("controlCenter"))));
    QVERIFY(imageLooksRendered(h.view->shot(QStringLiteral("control-center.png"))));
    QQuickItem* dark = nullptr;
    QQuickItem* light = nullptr;
    walkItems(h.view->root(), [&](QQuickItem* i) {
      if (!reallyVisible(i) || !i->inherits("QQuickAbstractButton")) return;
      if (i->property("text").toString() == QString::fromUtf8("深色")) dark = i;
      if (i->property("text").toString() == QString::fromUtf8("浅色")) light = i;
    });
    QVERIFY(dark && light);
    QMetaObject::invokeMethod(dark, "clicked");
    h.click(QStringLiteral("controlCenterButton"));   // close the popover
    QTest::qWait(300);
    const QImage d = h.view->shot(QStringLiteral("desktop-dark.png"));
    QVERIFY(imageLooksRendered(d));
    QVERIFY2(d.pixelColor(d.width() - 4, 3).lightness() < 40, qPrintable(d.pixelColor(d.width() - 4, 3).name()));
    h.click(QStringLiteral("nav:model"));
    QTest::qWait(300);
    QVERIFY(imageLooksRendered(h.view->shot(QStringLiteral("model-dark.png"))));
    h.click(QStringLiteral("controlCenterButton"));
    QTRY_VERIFY(reallyVisible(h.find(QStringLiteral("controlCenter"))));
    QMetaObject::invokeMethod(light, "clicked");
    QTest::qWait(200);
    QVERIFY2(g_qmlWarnings.isEmpty(), qPrintable(g_qmlWarnings.join(QLatin1Char('\n'))));
  }

  void sessionSettingsGoToTheSessionAgentNotAMachinePlan() {
    QTemporaryDir rt;
    const QByteArray oldRt = qgetenv("XDG_RUNTIME_DIR");
    qputenv("XDG_RUNTIME_DIR", rt.path().toUtf8());
    {
      FakeSessionAgent agent(rt.path());
      Harness h;
      QVERIFY(h.up());
      h.click(QStringLiteral("nav:hardware"));
      // the page shows the agent's real state: volume, outputs and modes (deduplicated), no brightness control
      QTRY_COMPARE(h.shell->sessionSettings().value(QStringLiteral("audio")).toMap().value(QStringLiteral("volume")).toInt(), 40);
      QTRY_VERIFY(h.find(QStringLiteral("volumeSlider")) && reallyVisible(h.find(QStringLiteral("volumeSlider"))));
      QQuickItem* modeSel = h.find(QStringLiteral("displayMode:Virtual-1"));
      QVERIFY(modeSel && reallyVisible(modeSel));
      QCOMPARE(modeSel->property("count").toInt(), 2);
      bool brightness = false;
      walkItems(h.view->root(), [&](QQuickItem* i) { brightness = brightness || i->property("text").toString().contains(QString::fromUtf8("亮度")) || accessibleName(i).contains(QString::fromUtf8("亮度")); });
      QVERIFY(!brightness);
      // battery and power read in machined's own shape
      QCOMPARE(h.find(QStringLiteral("batteryText"))->property("text").toString(), QString::fromUtf8("电量 82%，正在使用电池"));
      QVERIFY(h.find(QStringLiteral("powerReboot"))->isEnabled() && h.find(QStringLiteral("powerOff"))->isEnabled());
      QVERIFY(imageLooksRendered(h.view->shot(QStringLiteral("hardware.png"))));
      const int plans = h.sent(QStringLiteral("machine.actions.plan")).size();
      // volume and mute: one agent request each, no machine plan, no trusted confirmation
      h.shell->hardware(QStringLiteral("audio.volume.set"), {{QStringLiteral("percent"), 30}});
      QCOMPARE(agent.ops(QStringLiteral("audio.setVolume")).size(), 1);
      QCOMPARE(agent.ops(QStringLiteral("audio.setVolume")).first().value(QStringLiteral("percent")).toInt(), 30);
      QTRY_COMPARE(h.shell->sessionSettings().value(QStringLiteral("audio")).toMap().value(QStringLiteral("volume")).toInt(), 30);
      h.shell->hardware(QStringLiteral("audio.mute.set"), {{QStringLiteral("muted"), true}});
      QCOMPARE(agent.ops(QStringLiteral("audio.setMute")).size(), 1);
      QVERIFY(agent.ops(QStringLiteral("audio.setMute")).first().value(QStringLiteral("muted")).toBool());
      // display mode: the agent's display.set with the parsed mode, then the 15 s keep-or-revert window
      h.shell->hardware(QStringLiteral("display.mode.set"), {{QStringLiteral("output"), QStringLiteral("Virtual-1")}, {QStringLiteral("mode"), QStringLiteral("1920x1080")}, {QStringLiteral("scale"), 1}});
      QCOMPARE(agent.ops(QStringLiteral("display.set")).size(), 1);
      const QJsonObject ds = agent.ops(QStringLiteral("display.set")).first();
      QCOMPARE(ds.value(QStringLiteral("name")).toString(), QStringLiteral("Virtual-1"));
      QCOMPARE(ds.value(QStringLiteral("width")).toInt(), 1920);
      QCOMPARE(ds.value(QStringLiteral("height")).toInt(), 1080);
      QCOMPARE(ds.value(QStringLiteral("scale")).toDouble(), 1.0);
      QTRY_VERIFY_WITH_TIMEOUT(h.shell->displayRevertLeft() > 0, 5000);
      QVERIFY(h.shell->displayRevertLeft() <= 15);
      QTRY_VERIFY(h.find(QStringLiteral("displayKeep")) && reallyVisible(h.find(QStringLiteral("displayKeep"))));
      h.click(QStringLiteral("displayKeep"));
      QCOMPARE(h.shell->displayRevertLeft(), 0);
      QCOMPARE(agent.ops(QStringLiteral("display.keep")).size(), 1);
      QTest::qWait(100);
      QCOMPARE(h.sent(QStringLiteral("machine.actions.plan")).size(), plans);
      QVERIFY(!h.shell->confirm().value(QStringLiteral("visible")).toBool());
      // power off is the backend's power.poweroff, through the danger dialog and the trusted layer
      h.click(QStringLiteral("powerOff"));
      QTRY_VERIFY(reallyVisible(h.find(QStringLiteral("dangerSure"))));
      h.click(QStringLiteral("dangerSureAccept"));
      QTRY_COMPARE(h.sent(QStringLiteral("machine.actions.plan")).size(), plans + 1);
      QCOMPARE(h.sent(QStringLiteral("machine.actions.plan")).last().get(QStringLiteral("body")).get(QStringLiteral("actionKind")).str(), QStringLiteral("power.poweroff"));
      QTRY_VERIFY(h.shell->confirm().value(QStringLiteral("visible")).toBool());
      h.shell->confirmReject();
    }
    if (oldRt.isNull()) qunsetenv("XDG_RUNTIME_DIR");
    else qputenv("XDG_RUNTIME_DIR", oldRt);
  }

  void adminCreatesAndDisablesUsersThroughTheTrustedLayer() {
    Harness h;
    QVERIFY(h.up());
    h.click(QStringLiteral("nav:workspaces"));
    QTRY_VERIFY(h.find(QStringLiteral("createUser")));
    const QString initial = QStringLiteral("bea-initial-pw"), admin = QStringLiteral("admin-pw-2");
    h.find(QStringLiteral("newUserLogin"))->setProperty("text", QStringLiteral("bea"));
    h.find(QStringLiteral("newUserPassword"))->setProperty("text", initial);
    h.click(QStringLiteral("createUser"));
    QTRY_COMPARE(h.sent(QStringLiteral("machine.users.create")).size(), 1);
    const JValue req = h.sent(QStringLiteral("machine.users.create")).first().get(QStringLiteral("body"));
    QCOMPARE(req.get(QStringLiteral("loginName")).str(), QStringLiteral("bea"));    // the gateway's field names
    QCOMPARE(req.get(QStringLiteral("role")).str(), QStringLiteral("user"));
    QCOMPARE(req.get(QStringLiteral("password")).str(), initial);
    QVERIFY(h.find(QStringLiteral("newUserPassword"))->property("text").toString().isEmpty());
    // the plan is an admin plan on the trusted layer
    QTRY_VERIFY(h.shell->confirm().value(QStringLiteral("visible")).toBool());
    QCOMPARE(h.shell->confirm().value(QStringLiteral("what")).toString(), QString::fromUtf8("创建用户"));
    QVERIFY(h.shell->confirm().value(QStringLiteral("admin")).toBool());
    for (const auto& v : h.shell->confirm()) QVERIFY(!v.toString().contains(initial));
    h.shell->confirmAccept(admin);
    QTRY_COMPARE(h.sent(QStringLiteral("machine.actions.confirm")).size(), 1);
    const JValue conf = h.sent(QStringLiteral("machine.actions.confirm")).first();
    QCOMPARE(conf.get(QStringLiteral("params")).get(QStringLiteral("operationId")).str(), QStringLiteral("op-user"));
    QCOMPARE(conf.get(QStringLiteral("body")).get(QStringLiteral("password")).str(), admin);
    QVERIFY(!conf.stringify().contains(initial));
    auto* a = static_cast<ActionTracker*>(h.shell->actions());
    for (int i = 0; i < a->count(); ++i) QVERIFY(!a->at(i).stringify().contains(initial) && !a->at(i).stringify().contains(admin));
    // disabling is red: the danger dialog, then the same admin plan path with the id in the body
    h.find(QStringLiteral("disableUserId"))->setProperty("text", QStringLiteral("u-bea"));
    h.click(QStringLiteral("disableUser"));
    QTRY_VERIFY(reallyVisible(h.find(QStringLiteral("dangerSure"))));
    h.click(QStringLiteral("dangerSureAccept"));
    QTRY_COMPARE(h.sent(QStringLiteral("machine.users.disable")).size(), 1);
    QCOMPARE(h.sent(QStringLiteral("machine.users.disable")).first().get(QStringLiteral("body")).get(QStringLiteral("userId")).str(), QStringLiteral("u-bea"));
    QTRY_VERIFY(h.shell->confirm().value(QStringLiteral("visible")).toBool());
    QCOMPARE(h.shell->confirm().value(QStringLiteral("what")).toString(), QString::fromUtf8("停用用户"));
    h.shell->confirmReject();
    QTRY_COMPARE(h.sent(QStringLiteral("machine.actions.cancel")).size(), 1);
  }

  // Migrated from the removed web e2e suite (tests/e2e/*.spec.ts, Playwright): the four flows it guarded, driven
  // through the native Shell's own controls. The full-stack versions run in the VM tests (e2e_test mainline creates
  // apps from intents on the real gateway; e2e_sway clicks the trusted layer and the app dialog on a real output).
  void webE2eFlowsOnTheNativeDesktop() {
    Harness h;
    QVERIFY(h.up());
    // 1. create an app: the Home intent box sends one run request with the typed intent
    h.click(QStringLiteral("nav:home"));
    QTRY_VERIFY(h.find(QStringLiteral("intentInput")));
    h.find(QStringLiteral("intentInput"))->setProperty("text", QString::fromUtf8("做一个待办应用"));
    h.click(QStringLiteral("intentSubmit"));
    QTRY_COMPARE(h.sent(QStringLiteral("runs.post")).size(), 1);
    QCOMPARE(h.sent(QStringLiteral("runs.post")).first().get(QStringLiteral("body")).get(QStringLiteral("body")).get(QStringLiteral("intent")).str(), QString::fromUtf8("做一个待办应用"));
    QTRY_VERIFY(!h.actionState(QStringLiteral("runs.submit")).isEmpty() && h.actionState(QStringLiteral("runs.submit")) != QLatin1String("failed"));

    // 2. insufficient permission: the gateway refuses the write; the Shell says so and does not resend
    h.be.forbidRuns = true;
    h.find(QStringLiteral("intentInput"))->setProperty("text", QString::fromUtf8("再做一个记账应用"));
    h.click(QStringLiteral("intentSubmit"));
    QTRY_COMPARE(h.sent(QStringLiteral("runs.post")).size(), 2);
    auto* a = static_cast<ActionTracker*>(h.shell->actions());
    const auto denied = [&] {
      for (int i = 0; i < a->count(); ++i)
        if (a->at(i).get(QStringLiteral("label")).str() == QString::fromUtf8("意图：再做一个记账应用")) return a->at(i);
      return JValue::object();
    };
    QTRY_COMPARE(denied().get(QStringLiteral("state")).str(), QStringLiteral("failed"));
    QVERIFY2(denied().get(QStringLiteral("detail")).str().contains(QString::fromUtf8("对象不存在或你没有权限（NOT_FOUND_OR_FORBIDDEN）")), qPrintable(denied().stringify()));
    QTest::qWait(300);
    QCOMPARE(h.sent(QStringLiteral("runs.post")).size(), 2);
    h.be.forbidRuns = false;

    // 3. trusted confirmation: an app's system action only asks; the plan runs after the real Accept button
    const QString consoleId = h.be.console.get(QStringLiteral("app")).get(QStringLiteral("appId")).str();
    auto* vm = qobject_cast<AppViewModel*>(h.shell->appView(consoleId));
    QTRY_COMPARE(vm->mode(), QStringLiteral("slot"));
    QString path;
    for (const auto& st : h.be.console.get(QStringLiteral("steps")).items()) {
      if (st.get(QStringLiteral("op")).str() == QLatin1String("type")) vm->typeText(st.get(QStringLiteral("formId")).str(), st.get(QStringLiteral("name")).str(), st.get(QStringLiteral("raw")).str());
      if (st.get(QStringLiteral("op")).str() == QLatin1String("click") && st.get(QStringLiteral("expect")).get(QStringLiteral("result")).get(QStringLiteral("kind")).str() == QLatin1String("request")) {
        path = st.get(QStringLiteral("path")).str();
        break;
      }
    }
    QVERIFY(!path.isEmpty());
    vm->click(path);
    QTRY_VERIFY(reallyVisible(h.find(QStringLiteral("trustedConfirm"))));
    QCOMPARE(h.sent(QStringLiteral("systemactions.confirm.post")).size(), 0);
    h.click(QStringLiteral("confirmAccept"));
    QTRY_COMPARE(h.sent(QStringLiteral("systemactions.confirm.post")).size(), 1);
    QTRY_VERIFY(!h.shell->confirm().value(QStringLiteral("visible")).toBool());

    // 4. app confirmation: the app's own question is an ordinary dialog; refusing sends nothing, accepting sends once
    JValue cov = loadFixture(QStringLiteral("v1.0/slot-vectors/scenario-v3-coverage.json"));
    auto* app = new AppViewModel(cov.get(QStringLiteral("app")).get(QStringLiteral("appId")).str(), h.shell.get(), h.shell.get());
    app->setDetail(JValue::object({{QStringLiteral("appId"), cov.get(QStringLiteral("app")).get(QStringLiteral("appId"))}, {QStringLiteral("appEpoch"), cov.get(QStringLiteral("app")).get(QStringLiteral("appEpoch"))},
                                   {QStringLiteral("activeRevisionId"), cov.get(QStringLiteral("app")).get(QStringLiteral("revisionId"))}, {QStringLiteral("bundle"), cov.get(QStringLiteral("bundle"))}}));
    QCOMPARE(app->mode(), QStringLiteral("slot"));
    const QString purge = QStringLiteral("/view/slots/toolbar/children/1");  // the coverage scenario's "清空" (confirm: 确定清空？)
    app->click(purge);
    QTRY_VERIFY(reallyVisible(h.find(QStringLiteral("appConfirm"))));
    QVERIFY(!reallyVisible(h.find(QStringLiteral("trustedConfirm"))));
    QCOMPARE(h.shell->appConfirm().value(QStringLiteral("text")).toString(), QString::fromUtf8("确定清空？"));
    h.click(QStringLiteral("appConfirmReject"));
    QTRY_VERIFY(!h.shell->appConfirm().value(QStringLiteral("visible")).toBool());
    QTest::qWait(200);
    QCOMPARE(h.sent(QStringLiteral("apps.commands.post")).size(), 0);
    app->click(purge);
    QTRY_VERIFY(reallyVisible(h.find(QStringLiteral("appConfirm"))));
    h.click(QStringLiteral("appConfirmAccept"));
    QTRY_COMPARE(h.sent(QStringLiteral("apps.commands.post")).size(), 1);
    QCOMPARE(h.sent(QStringLiteral("apps.commands.post")).first().get(QStringLiteral("body")).get(QStringLiteral("params")).get(QStringLiteral("commandId")).str(), QStringLiteral("purge"));
  }

  void homeShowsHostNotificationsInTheirOwnShape() {
    Harness h;
    h.be.withNotification = true;
    QVERIFY(h.up());
    h.click(QStringLiteral("nav:home"));
    QTRY_VERIFY(h.find(QStringLiteral("notification:n-disk")));
    QQuickItem* n = h.find(QStringLiteral("notification:n-disk"));
    QCOMPARE(n->property("text").toString(), QString::fromUtf8("磁盘空间不足（3 次）"));
    QCOMPARE(n->property("color").value<QColor>(), QColor(QStringLiteral("#c03a2b")));  // Theme.danger (light)
  }

  void updateActivationUsesTheBackendStatesAndAnAdminPlan() {
    Harness h;
    const QString uid = QStringLiteral("77777777-7777-4777-8777-777777777777");
    h.be.update = JValue::object({{QStringLiteral("updateId"), uid}, {QStringLiteral("state"), QStringLiteral("downloading")}, {QStringLiteral("fromReleaseId"), QStringLiteral("1.0.0")},
                                  {QStringLiteral("toReleaseId"), QStringLiteral("1.0.1")}, {QStringLiteral("target"), JValue::object({{QStringLiteral("releaseId"), QStringLiteral("1.0.1")}, {QStringLiteral("manifestHash"), QStringLiteral("sha256:") + QString(64, QLatin1Char('8'))}})}});
    QVERIFY(h.up());
    h.click(QStringLiteral("nav:update"));
    QTRY_VERIFY(h.find(QStringLiteral("updateSummary")) && h.find(QStringLiteral("updateSummary"))->property("text").toString().contains(QStringLiteral("1.0.1")));
    QVERIFY(h.find(QStringLiteral("updateSummary"))->property("text").toString().contains(QString::fromUtf8("下载中")));
    QVERIFY(!h.find(QStringLiteral("updateActivate"))->isEnabled());  // still downloading
    // staged (the backend's name for a prepared update): activation is offered
    h.be.update.set(QStringLiteral("state"), QStringLiteral("staged"));
    h.shell->refreshPage();
    QTRY_VERIFY(h.find(QStringLiteral("updateActivate"))->isEnabled());
    QVERIFY(h.find(QStringLiteral("updateSummary"))->property("text").toString().contains(QString::fromUtf8("可以激活")));
    h.click(QStringLiteral("updateActivate"));
    QTRY_VERIFY(reallyVisible(h.find(QStringLiteral("dangerSure"))));
    h.click(QStringLiteral("dangerSureAccept"));
    QTRY_VERIFY(h.shell->confirm().value(QStringLiteral("visible")).toBool());
    const JValue plan = h.sent(QStringLiteral("machine.actions.plan")).last().get(QStringLiteral("body"));
    QCOMPARE(plan.get(QStringLiteral("actionKind")).str(), QStringLiteral("admin.update"));
    QCOMPARE(plan.get(QStringLiteral("params")).get(QStringLiteral("step")).str(), QStringLiteral("activate"));
    QCOMPARE(plan.get(QStringLiteral("params")).get(QStringLiteral("updateId")).str(), uid);
    QVERIFY(h.shell->confirm().value(QStringLiteral("admin")).toBool());
    QVERIFY(reallyVisible(h.find(QStringLiteral("confirmAdminPassword"))));
    QVERIFY(h.shell->confirm().value(QStringLiteral("effect")).toString().contains(QStringLiteral("agentosctl update activate")));
    h.shell->confirmReject();
    QTest::qWait(100);
    QCOMPARE(h.sent(QStringLiteral("machine.actions.confirm")).size(), 0);
  }

  void adminPlanShowsDetailsAndSendsThePasswordOnlyInTheConfirm() {
    Harness h;
    QVERIFY(h.up());
    h.click(QStringLiteral("nav:hardware"));
    const QString pw = QStringLiteral("admin-pw-1");
    h.shell->hardware(QStringLiteral("time.timezone.set"), {{QStringLiteral("zone"), QStringLiteral("Asia/Shanghai")}});
    QTRY_VERIFY(h.shell->confirm().value(QStringLiteral("visible")).toBool());
    const QVariantMap c = h.shell->confirm();
    // what, to what, before/after, risk, reversibility and expiry are on the trusted layer
    QCOMPARE(c.value(QStringLiteral("what")).toString(), QString::fromUtf8("更改系统时区"));
    QCOMPARE(c.value(QStringLiteral("resource")).toString(), QStringLiteral("timedate:zone"));
    QCOMPARE(c.value(QStringLiteral("before")).toString(), QStringLiteral("UTC"));
    QCOMPARE(c.value(QStringLiteral("after")).toString(), QStringLiteral("Asia/Shanghai"));
    QVERIFY(!c.value(QStringLiteral("risk")).toString().isEmpty());
    QVERIFY(!c.value(QStringLiteral("reversible")).toString().isEmpty());
    QVERIFY(c.value(QStringLiteral("expires")).toString().contains(QString::fromUtf8("10 分钟")));
    QVERIFY(c.value(QStringLiteral("admin")).toBool());
    for (const char* n : {"confirmWhat", "confirmBefore", "confirmAfter", "confirmRisk", "confirmReversible", "confirmExpires", "confirmAdminPassword"})
      QVERIFY2(h.find(QString::fromLatin1(n)) && reallyVisible(h.find(QString::fromLatin1(n))), n);
    // no password: the accept button is disabled and a direct accept sends nothing
    QVERIFY(!h.find(QStringLiteral("confirmAccept"))->isEnabled());
    h.shell->confirmAccept();
    QTest::qWait(100);
    QCOMPARE(h.sent(QStringLiteral("machine.actions.confirm")).size(), 0);
    QVERIFY(h.shell->confirm().value(QStringLiteral("visible")).toBool());
    QVERIFY(imageLooksRendered(h.view->shot(QStringLiteral("trusted-confirm-admin.png"))));
    // typed into the field, the password reaches the gateway in the confirm request and nowhere else
    h.find(QStringLiteral("confirmAdminPassword"))->setProperty("text", pw);
    h.click(QStringLiteral("confirmAccept"));
    QTRY_COMPARE(h.sent(QStringLiteral("machine.actions.confirm")).size(), 1);
    const JValue conf = h.sent(QStringLiteral("machine.actions.confirm")).first();
    QCOMPARE(conf.get(QStringLiteral("body")).get(QStringLiteral("password")).str(), pw);
    QCOMPARE(conf.get(QStringLiteral("body")).get(QStringLiteral("planHash")).str(), QStringLiteral("sha256:") + QString(64, QLatin1Char('3')));
    QTRY_COMPARE(h.actionState(QStringLiteral("machine.confirm")), QStringLiteral("reconciled"));
    for (const auto& r : h.sent(QStringLiteral("machine.actions.plan"))) QVERIFY(!r.stringify().contains(pw));
    auto* a = static_cast<ActionTracker*>(h.shell->actions());
    for (int i = 0; i < a->count(); ++i) QVERIFY(!a->at(i).stringify().contains(pw));
    QVERIFY(h.find(QStringLiteral("confirmAdminPassword"))->property("text").toString().isEmpty());
  }

  void systemActionButtonOnlyRequestsAPlan() {
    Harness h;
    QVERIFY(h.up());
    const QString consoleId = h.be.console.get(QStringLiteral("app")).get(QStringLiteral("appId")).str();
    auto* vm = qobject_cast<AppViewModel*>(h.shell->appView(consoleId));
    QTRY_COMPARE(vm->mode(), QStringLiteral("slot"));
    QTRY_VERIFY(vm->runtime().render().stringify().contains(QStringLiteral("SystemActionButton")));
    // replay the console scenario's valid click: the button's command input comes from its form
    JValue steps = h.be.console.get(QStringLiteral("steps"));
    QString path;
    for (const auto& st : steps.items()) {
      if (st.get(QStringLiteral("op")).str() == QLatin1String("type")) vm->typeText(st.get(QStringLiteral("formId")).str(), st.get(QStringLiteral("name")).str(), st.get(QStringLiteral("raw")).str());
      if (st.get(QStringLiteral("op")).str() == QLatin1String("click") && st.get(QStringLiteral("expect")).get(QStringLiteral("result")).get(QStringLiteral("kind")).str() == QLatin1String("request")) {
        path = st.get(QStringLiteral("path")).str();
        break;
      }
    }
    QVERIFY(!path.isEmpty());
    vm->click(path);
    QTRY_COMPARE(h.sent(QStringLiteral("apps.systemactions.post")).size(), 1);
    QTRY_VERIFY(h.shell->confirm().value(QStringLiteral("visible")).toBool());
    QCOMPARE(h.sent(QStringLiteral("systemactions.confirm.post")).size(), 0);
    QCOMPARE(h.shell->confirm().value(QStringLiteral("planHash")).toString(), QStringLiteral("sha256:") + QString(64, QLatin1Char('9')));
    h.shell->confirmAccept();
    QTRY_COMPARE(h.sent(QStringLiteral("systemactions.confirm.post")).size(), 1);
    QCOMPARE(h.sent(QStringLiteral("systemactions.confirm.post")).first().get(QStringLiteral("body")).get(QStringLiteral("body")).get(QStringLiteral("planHash")).str(), QStringLiteral("sha256:") + QString(64, QLatin1Char('9')));
  }

  void lockClearsSensitiveStateEverywhere() {
    Harness h;
    QVERIFY(h.up());
    const QString kan = h.be.kanban.get(QStringLiteral("app")).get(QStringLiteral("appId")).str();
    auto* vm = qobject_cast<AppViewModel*>(h.shell->appView(kan));
    QTRY_COMPARE(vm->mode(), QStringLiteral("slot"));
    JValue steps = h.be.kanban.get(QStringLiteral("steps"));
    for (const auto& st : steps.items())
      if (st.get(QStringLiteral("op")).str() == QLatin1String("type")) {
        vm->typeText(st.get(QStringLiteral("formId")).str(), st.get(QStringLiteral("name")).str(), QStringLiteral("我的银行卡密码"));
        break;
      }
    QVERIFY(vm->runtime().formsSnapshot().stringify().contains(QString::fromUtf8("银行卡")));
    h.shell->setIntentDraft(QString::fromUtf8("帮我记住密码"));
    QGuiApplication::clipboard()->setText(QStringLiteral("copied secret"));
    h.be.locked = true;
    h.be.sessionEpoch = 5;
    QTRY_VERIFY_WITH_TIMEOUT(h.shell->locked(), 8000);  // picked up from session.status (sessionEpoch change)
    QVERIFY(!vm->runtime().formsSnapshot().stringify().contains(QString::fromUtf8("银行卡")));
    QVERIFY(h.shell->intentDraft().isEmpty());
    QVERIFY(QGuiApplication::clipboard()->text().isEmpty());
    QCOMPARE(static_cast<JsonListModel*>(h.shell->notifications())->count(), 0);
    QVERIFY(h.find(QStringLiteral("lockMask"))->isVisible());
    // locked: machine actions/member changes are refused locally
    const int plans = h.sent(QStringLiteral("machine.actions.plan")).size();
    h.shell->hardware(QStringLiteral("power.reboot"), {});
    QTest::qWait(100);
    QCOMPARE(h.sent(QStringLiteral("machine.actions.plan")).size(), plans);
    // unlock -> rebind
    h.be.locked = false;
    QTRY_VERIFY_WITH_TIMEOUT(!h.shell->locked(), 8000);
    QCOMPARE(h.shell->sessionEpoch(), qint64(5));
  }

  void workspaceSwitchDropsLateResponses() {
    Harness h;
    QVERIFY(h.up());
    const QString kan = h.be.kanban.get(QStringLiteral("app")).get(QStringLiteral("appId")).str();
    h.be.holdQueries = true;
    auto* vm = qobject_cast<AppViewModel*>(h.shell->appView(kan));
    QTRY_COMPARE(vm->mode(), QStringLiteral("slot"));
    QTRY_VERIFY(h.sent(QStringLiteral("apps.queries.post")).size() >= 1);
    const QString heldId = h.sent(QStringLiteral("apps.queries.post")).last().get(QStringLiteral("requestId")).str();
    QPointer<AppViewModel> oldView(vm);
    const int dropped = h.shell->lateDropped();
    h.shell->switchWorkspace(WS_B);
    QTRY_COMPARE(h.shell->workspaceId(), WS_B);
    QTRY_VERIFY_WITH_TIMEOUT(h.sent(QStringLiteral("workspaces.attach")).size() >= 2, 5000);
    // the held A-scope answer arrives after the switch: dropped, never applied to B
    QMetaObject::invokeMethod(h.gw->gw, "reply", Qt::BlockingQueuedConnection, Q_ARG(QString, heldId),
                              Q_ARG(agentos::JValue, JValue::object({{QStringLiteral("output"), JValue::object()}, {QStringLiteral("revisionId"), QStringLiteral("x")}, {QStringLiteral("appEpoch"), 3}})));
    QTRY_VERIFY(h.shell->lateDropped() > dropped);
    QTRY_VERIFY(oldView.isNull());  // A's view (forms, selection, text caches) is gone
    // event subscription moved to B
    QTRY_VERIFY(([&] {
      for (const auto& r : h.sent(QStringLiteral("events.subscribe")))
        if (r.get(QStringLiteral("params")).get(QStringLiteral("workspaceId")).str() == WS_B) return true;
      return false;
    }()));
    // events for A are now ignored by the transport (unsubscribed)
    QMetaObject::invokeMethod(h.gw->gw, "sendEvent", Qt::BlockingQueuedConnection, Q_ARG(QString, WS_A), Q_ARG(qint64, 11), Q_ARG(QString, QStringLiteral("membership.revoked")), Q_ARG(agentos::JValue, JValue::object({{QStringLiteral("userId"), QStringLiteral("u-alice")}})));
    QTest::qWait(200);
    QVERIFY(!h.shell->writesStopped());
  }

  // V1-W05: a fast A -> B -> A round trip. The answer held from the FIRST visit to A comes back while the Shell is
  // on A again: same workspaceId, but an older scope, so it is dropped and never shown in the new A view.
  void rapidRoundTripDropsAnswersFromTheEarlierVisit() {
    Harness h;
    QVERIFY(h.up());
    const QString kan = h.be.kanban.get(QStringLiteral("app")).get(QStringLiteral("appId")).str();
    h.be.holdQueries = true;
    auto* vm = qobject_cast<AppViewModel*>(h.shell->appView(kan));
    QTRY_COMPARE(vm->mode(), QStringLiteral("slot"));
    QTRY_VERIFY(h.sent(QStringLiteral("apps.queries.post")).size() >= 1);
    const QString heldId = h.sent(QStringLiteral("apps.queries.post")).last().get(QStringLiteral("requestId")).str();
    QPointer<AppViewModel> firstView(vm);
    const int dropped = h.shell->lateDropped();
    const int attaches = h.sent(QStringLiteral("workspaces.attach")).size();
    h.shell->switchWorkspace(WS_B);
    h.shell->switchWorkspace(WS_A);  // back before B has even settled
    QTRY_COMPARE(h.shell->workspaceId(), WS_A);
    QTRY_VERIFY_WITH_TIMEOUT(h.sent(QStringLiteral("workspaces.attach")).size() >= attaches + 2, 5000);
    QTRY_VERIFY(firstView.isNull());  // the first A view (forms, selection, caches) is gone
    QMetaObject::invokeMethod(h.gw->gw, "reply", Qt::BlockingQueuedConnection, Q_ARG(QString, heldId),
                              Q_ARG(agentos::JValue, JValue::object({{QStringLiteral("output"), JValue::object({{QStringLiteral("marker"), QStringLiteral("FIRST-VISIT-BODY")}})}, {QStringLiteral("revisionId"), QStringLiteral("x")}, {QStringLiteral("appEpoch"), 3}})));
    QTRY_VERIFY(h.shell->lateDropped() > dropped);
    // whatever the new A view shows, it is not the first visit's answer
    if (auto* now = qobject_cast<AppViewModel*>(h.shell->appView(kan))) {
      QTest::qWait(200);
      QVERIFY(!now->runtime().formsSnapshot().stringify().contains(QStringLiteral("FIRST-VISIT-BODY")));
    }
    // the event subscription ends on A, not B
    QTRY_VERIFY(([&] {
      const auto subs = h.sent(QStringLiteral("events.subscribe"));
      return !subs.isEmpty() && subs.last().get(QStringLiteral("params")).get(QStringLiteral("workspaceId")).str() == WS_A;
    }()));
  }

  // m13 W05 run 41173405389: an app opened right after a switch, before the attach answers, stayed "loading" because
  // its detail request carried the pre-attach scope and its answer was dropped.
  void appOpenedBeforeAttachAnswersStillLoads() {
    Harness h;
    QVERIFY(h.up());
    const QString kan = h.be.kanban.get(QStringLiteral("app")).get(QStringLiteral("appId")).str();
    h.shell->switchWorkspace(WS_B);
    auto* vm = qobject_cast<AppViewModel*>(h.shell->appView(kan));
    QVERIFY(vm);
    QTRY_COMPARE_WITH_TIMEOUT(vm->mode(), QStringLiteral("slot"), 5000);
  }

  void missingNativeHealthFieldsDoNotRecoverAStoppedWorkspaceHost() {
    Harness h;
    h.be.nativeStatusShape = true;
    QVERIFY(h.up());
    h.shell->setCurrentPage(QStringLiteral("hardware"));
    QTest::qWait(100);  // let the explicit page refresh finish before observing background probes
    QSignalSpy resets(qobject_cast<QAbstractItemModel*>(h.shell->canvas()), &QAbstractItemModel::modelReset);
    QVERIFY(resets.isValid());
    const int probes = h.sent(QStringLiteral("state.list")).size();
    QTRY_VERIFY_WITH_TIMEOUT(h.sent(QStringLiteral("state.list")).size() > probes, 20000);
    QTest::qWait(100);
    QCOMPARE(resets.count(), 0);  // background health probes must not rebuild focused app delegates
    h.be.hostDown = true;
    // No user refresh and no fictional components.host field: periodic probes must observe the real Host.
    QTRY_VERIFY_WITH_TIMEOUT(!h.shell->hostAvailable(), 20000);  // existing 5-second status timer probes every third tick
    h.gw->gw->setHandler([&](const JValue& r) {
      if (r.get(QStringLiteral("methodId")).str() == QLatin1String("workspace.forward")) return JValue::missing();
      return h.be.handle(r);
    });
    const QString cached = h.shell->cachedAt();
    QVERIFY(!h.shell->act(QStringLiteral("workspaces.list")).isEmpty());
    QTRY_COMPARE(h.actionState(QStringLiteral("workspaces.list")), QStringLiteral("reconciled"));
    QTest::qWait(100);
    QCOMPARE(h.shell->cachedAt(), cached);  // machine replies cannot make stale workspace data look freshly read
    QVERIFY(!h.shell->hostAvailable());  // neither native replies nor action receipts prove the Host recovered
    QVERIFY(h.shell->readOnly());
    h.gw->gw->setHandler([&](const JValue& r) { return h.be.handle(r); });
    h.be.hostDown = false;
    h.shell->refreshPage();
    QTRY_VERIFY_WITH_TIMEOUT(h.shell->hostAvailable(), 5000);
  }

  // A refusal that answers a request sent while the Host was down must not undo newer proof that it is back.
  void staleHostRefusalAfterRecoveryKeepsTheHostAvailable() {
    Harness h;
    QVERIFY(h.up());
    h.be.hostDown = true;
    h.shell->refreshPage();
    QTRY_VERIFY_WITH_TIMEOUT(!h.shell->hostAvailable(), 20000);
    const int before = h.sent(QStringLiteral("workspace.forward")).size();
    h.gw->gw->setHandler([&](const JValue& r) {
      if (r.get(QStringLiteral("methodId")).str() == QLatin1String("workspace.forward")) return JValue::missing();  // held
      return h.be.handle(r);
    });
    h.shell->refreshPage();
    QTRY_VERIFY(h.sent(QStringLiteral("workspace.forward")).size() > before);
    QTest::qWait(100);  // the whole refresh is in flight and held
    QVector<QString> held;
    for (const auto& r : h.sent(QStringLiteral("workspace.forward")).mid(before)) held << r.get(QStringLiteral("requestId")).str();
    h.gw->gw->setHandler([&](const JValue& r) { return h.be.handle(r); });
    h.be.hostDown = false;
    h.shell->refreshPage();
    QTRY_VERIFY_WITH_TIMEOUT(h.shell->hostAvailable(), 5000);
    for (const auto& id : held) h.gw->run([&] { h.gw->gw->reply(id, Backend::err(QStringLiteral("HOST_UNAVAILABLE"))); });
    QTest::qWait(300);
    QVERIFY2(h.shell->hostAvailable(), qPrintable(QStringLiteral("held=%1 banner=%2").arg(held.size()).arg(h.shell->banner())));
    QVERIFY(!h.shell->readOnly());
  }

  void startingHostStatusNeverFlashesTheBannerOverAWorkingHost() {
    // m20 D11 run 41930998357: after reattach the banner was there when "打开" was aimed and gone when the click landed.
    // A machine.status that reports the Host "starting" while its forwards already succeed is not an outage.
    Harness h;
    QVERIFY(h.up());
    QTRY_VERIFY(h.shell->hostAvailable());
    QStringList banners;
    QObject::connect(h.shell.get(), &ShellController::statusChanged, [&] { banners << h.shell->banner(); });
    h.gw->gw->setHandler([&](const JValue& r) {
      if (r.get(QStringLiteral("methodId")).str() == QLatin1String("machine.status"))
        return JValue::object({{QStringLiteral("components"), JValue::object({{QStringLiteral("host"), QStringLiteral("starting")}, {QStringLiteral("model"), QStringLiteral("ok")}, {QStringLiteral("broker"), QStringLiteral("ok")}})}});
      return h.be.handle(r);
    });
    const int before = h.sent(QStringLiteral("machine.status")).size();
    h.shell->setCurrentPage(QStringLiteral("hardware"));
    QTRY_VERIFY(h.sent(QStringLiteral("machine.status")).size() > before);
    h.shell->setCurrentPage(QStringLiteral("home"));
    h.shell->refreshPage();
    QTest::qWait(500);
    QVERIFY2(h.shell->hostAvailable(), qPrintable(banners.join(QStringLiteral(" | "))));
    for (const QString& b : banners) QVERIFY2(b.isEmpty(), qPrintable(QStringLiteral("banner flashed: ") + banners.join(QStringLiteral(" | "))));
    // an explicit stop is still an outage (the Host really stopped: its forwards are refused too)
    h.gw->gw->setHandler([&](const JValue& r) {
      if (r.get(QStringLiteral("methodId")).str() == QLatin1String("machine.status"))
        return JValue::object({{QStringLiteral("components"), JValue::object({{QStringLiteral("host"), QStringLiteral("stopped")}})}});
      return h.be.handle(r);
    });
    h.be.hostDown = true;
    h.shell->setCurrentPage(QStringLiteral("hardware"));
    QTRY_VERIFY(!h.shell->hostAvailable());
  }

  void workspaceSwitcherNamesEveryWorkspaceAcrossHostStopAndReattach() {
    Harness h;
    QVERIFY(h.up());
    QQuickItem* sw = h.find(QStringLiteral("workspaceSwitcher"));
    QVERIFY(sw);
    auto labels = [&] {
      QStringList o;
      for (const QVariant& v : sw->property("options").toList()) o << v.toMap().value(QStringLiteral("label")).toString();
      return o;
    };
    const QStringList both{QString::fromUtf8("家庭"), QString::fromUtf8("工作")};
    QTRY_COMPARE(labels(), both);
    // Host down, a refused list, then reattach to B and back to A: the rows and their names stay whole
    h.be.hostDown = true;
    h.shell->refreshPage();
    QTRY_VERIFY_WITH_TIMEOUT(!h.shell->hostAvailable(), 20000);
    h.gw->gw->setHandler([&](const JValue& r) {
      if (r.get(QStringLiteral("methodId")).str() == QLatin1String("workspaces.list")) return Backend::err(QStringLiteral("HOST_UNAVAILABLE"));
      return h.be.handle(r);
    });
    h.shell->setCurrentPage(QStringLiteral("workspaces"));
    QTest::qWait(300);
    QCOMPARE(labels(), both);
    h.gw->gw->setHandler([&](const JValue& r) { return h.be.handle(r); });
    h.be.hostDown = false;
    h.shell->switchWorkspace(WS_B);
    QTRY_VERIFY_WITH_TIMEOUT(h.shell->workspaceId() == WS_B && h.shell->hostAvailable(), 5000);
    QCOMPARE(labels(), both);
    h.shell->switchWorkspace(WS_A);
    QTRY_VERIFY_WITH_TIMEOUT(h.shell->workspaceId() == WS_A, 5000);
    QCOMPARE(labels(), both);
    // a row without a name is offered by its id, never as a blank option
    h.gw->gw->setHandler([&](const JValue& r) {
      if (r.get(QStringLiteral("methodId")).str() == QLatin1String("workspaces.list"))
        return JValue::object({{QStringLiteral("items"), JValue::array({JValue::object({{QStringLiteral("workspaceId"), WS_A}, {QStringLiteral("displayName"), QString()}, {QStringLiteral("role"), QStringLiteral("owner")}})})}});
      return h.be.handle(r);
    });
    h.shell->setCurrentPage(QStringLiteral("workspaces"));
    h.shell->refreshPage();
    QTRY_COMPARE(labels(), QStringList{WS_A});
    // and the model reads past its end as missing, not as whatever is left in memory
    auto* m = static_cast<JsonListModel*>(h.shell->workspaces());
    QVERIFY(m->at(m->count()).isMissing() && m->at(-1).isMissing());
  }

  void nativeWorkspaceStateReportsBrokerAndModelIndependently() {
    Harness h;
    h.be.nativeStatusShape = true;
    QVERIFY(h.up());
    h.be.brokerDown = true;
    h.shell->setCurrentPage(QStringLiteral("hardware"));
    QTRY_VERIFY_WITH_TIMEOUT(!h.shell->brokerAvailable(), 5000);
    QVERIFY(h.shell->hostAvailable());
    QVERIFY(h.shell->canWrite(false));
    QVERIFY(!h.shell->canWrite(true));
    h.be.brokerDown = false;
    h.shell->refreshPage();
    QTRY_VERIFY_WITH_TIMEOUT(h.shell->brokerAvailable(), 5000);
    h.be.modelDown = true;
    h.shell->refreshPage();
    QTRY_VERIFY_WITH_TIMEOUT(!h.shell->modelAvailable(), 5000);
    QVERIFY(h.shell->canWrite(false));
  }

  void aLatePrivateNotificationCannotRefillStateAfterLock() {
    Harness h;
    QVERIFY(h.up());
    h.gw->gw->setHandler([&](const JValue& r) {
      if (r.get(QStringLiteral("body")).get(QStringLiteral("routeId")).str() == QLatin1String("notifications.list")) return JValue::missing();
      return h.be.handle(r);
    });
    const int before = h.sent(QStringLiteral("notifications.list")).size();
    h.shell->refreshPage();
    QTRY_VERIFY(h.sent(QStringLiteral("notifications.list")).size() > before);
    const QString pending = h.sent(QStringLiteral("notifications.list")).last().get(QStringLiteral("requestId")).str();
    h.be.sessionEpoch = 2;
    h.be.locked = true;
    QTRY_VERIFY_WITH_TIMEOUT(h.shell->locked(), 10000);  // metadata is observed on the existing 5-second status timer
    const int late = h.shell->transportStats().value(QStringLiteral("lateDropped")).toInt();
    const auto old = JValue::object({{QStringLiteral("items"), JValue::array({JValue::object({{QStringLiteral("id"), QStringLiteral("old")}, {QStringLiteral("text"), QStringLiteral("private before lock")}})})}});
    QMetaObject::invokeMethod(h.gw->gw, "reply", Qt::BlockingQueuedConnection, Q_ARG(QString, pending), Q_ARG(agentos::JValue, old));
    QTRY_VERIFY(h.shell->transportStats().value(QStringLiteral("lateDropped")).toInt() > late);
    QCOMPARE(h.shell->notifications()->property("count").toInt(), 0);
  }

  void degradedModes() {
    Harness h;
    QVERIFY(h.up());
    // model down: active apps keep running, intent submission disabled
    h.be.modelDown = true;
    h.shell->refreshPage();
    QTRY_VERIFY_WITH_TIMEOUT(!h.shell->modelAvailable(), 20000);
    QVERIFY(h.shell->act(QStringLiteral("runs.submit"), {{QStringLiteral("intent"), QStringLiteral("x")}}).isEmpty());
    QVERIFY(h.shell->canWrite(false));
    // broker down: plain CRUD still allowed, system actions refused
    h.be.brokerDown = true;
    QTRY_VERIFY_WITH_TIMEOUT(!h.shell->brokerAvailable(), 20000);
    QVERIFY(h.shell->canWrite(false));
    QVERIFY(!h.shell->canWrite(true));
    auto* rec = qobject_cast<AppViewModel*>(h.shell->appView(QStringLiteral("rec-app")));
    QTRY_COMPARE(rec->mode(), QStringLiteral("records"));
    rec->openCreate();
    rec->setDraft(QStringLiteral("title"), QString::fromUtf8("买牛奶"));
    rec->submitRecord();
    QTRY_COMPARE(h.sent(QStringLiteral("apps.records.post")).size(), 1);
    // Host down: read-only cache with its timestamp; submits refused locally
    h.be.hostDown = true;
    h.shell->refreshPage();
    QTRY_VERIFY_WITH_TIMEOUT(!h.shell->hostAvailable(), 20000);
    QVERIFY(h.shell->readOnly());
    QVERIFY(!h.shell->cachedAt().isEmpty());
    QVERIFY(h.shell->banner().contains(h.shell->cachedAt()));
    const int writes = h.sent(QStringLiteral("runs.cancel.post")).size();
    QVERIFY(h.shell->act(QStringLiteral("runs.cancel"), {{QStringLiteral("runId"), QStringLiteral("run-1")}}).isEmpty());
    QCOMPARE(h.sent(QStringLiteral("runs.cancel.post")).size(), writes);
    h.be.hostDown = false;
    h.be.modelDown = false;
    h.be.brokerDown = false;
    QTRY_VERIFY_WITH_TIMEOUT(h.shell->hostAvailable() && h.shell->modelAvailable() && h.shell->brokerAvailable(), 20000);
    // gateway gone: disconnected banner + reconnect; comes back by itself
    QMetaObject::invokeMethod(h.gw->gw, "dropConnection", Qt::BlockingQueuedConnection);
    QTRY_VERIFY_WITH_TIMEOUT(h.shell->rpc()->stats().reconnects >= 1, 5000);
    QTRY_VERIFY_WITH_TIMEOUT(h.shell->connected(), 5000);
    QTRY_VERIFY_WITH_TIMEOUT(h.sent(QStringLiteral("session.bind")).size() >= 2, 5000);
  }

  void staleRecordListAnswerNeverOverwritesNewerSearch() {
    Harness h;
    QVERIFY(h.up());
    auto* rec = qobject_cast<AppViewModel*>(h.shell->appView(QStringLiteral("rec-app")));
    QTRY_COMPARE(rec->mode(), QStringLiteral("records"));
    QTRY_VERIFY(h.sent(QStringLiteral("apps.records.list")).size() >= 1);
    h.be.holdRecordLists = true;
    const int before = h.sent(QStringLiteral("apps.records.list")).size();
    rec->setSearch(QString());
    QTRY_COMPARE(h.sent(QStringLiteral("apps.records.list")).size(), before + 1);
    const QString olderId = h.sent(QStringLiteral("apps.records.list")).last().get(QStringLiteral("requestId")).str();
    rec->setSearch(QStringLiteral("NEEDLE"));
    QTRY_COMPARE(h.sent(QStringLiteral("apps.records.list")).size(), before + 2);
    const QString newerId = h.sent(QStringLiteral("apps.records.list")).last().get(QStringLiteral("requestId")).str();
    const auto item = [](const QString& id, const QString& title) {
      return JValue::object({{QStringLiteral("id"), id}, {QStringLiteral("recordVersion"), 1}, {QStringLiteral("data"), JValue::object({{QStringLiteral("title"), title}})}});
    };
    QMetaObject::invokeMethod(h.gw->gw, "reply", Qt::BlockingQueuedConnection, Q_ARG(QString, newerId),
                              Q_ARG(agentos::JValue, JValue::object({{QStringLiteral("items"), JValue::array({item(QStringLiteral("r-n"), QStringLiteral("NEEDLE"))})}, {QStringLiteral("total"), 1}})));
    QTRY_COMPARE(rec->recordState().value(QStringLiteral("total")).toInt(), 1);
    QMetaObject::invokeMethod(h.gw->gw, "reply", Qt::BlockingQueuedConnection, Q_ARG(QString, olderId),
                              Q_ARG(agentos::JValue, JValue::object({{QStringLiteral("items"), JValue::array({item(QStringLiteral("r-a"), QStringLiteral("a")), item(QStringLiteral("r-b"), QStringLiteral("b")),
                                                                                                             item(QStringLiteral("r-n"), QStringLiteral("NEEDLE"))})},
                                                                     {QStringLiteral("total"), 3}})));
    QTest::qWait(300);
    QCOMPARE(rec->recordState().value(QStringLiteral("total")).toInt(), 1);
    QCOMPARE(static_cast<RecordsModel*>(rec->records())->rows(), 1);
    QCOMPARE(rec->recordState().value(QStringLiteral("q")).toString(), QStringLiteral("NEEDLE"));
  }

  void eventGapAndNormalisedRecordHintsRefreshDataWithoutDiscardingDrafts() {
    std::atomic<int> count{0};
    Harness h;
    h.gw->gw->setHandler([&](const JValue& r) {
      if (r.get(QStringLiteral("body")).get(QStringLiteral("routeId")).str() == QLatin1String("apps.records.list")) {
        const auto row = JValue::object({{QStringLiteral("id"), QStringLiteral("server-1")}, {QStringLiteral("recordVersion"), 1},
                                        {QStringLiteral("data"), JValue::object({{QStringLiteral("title"), QStringLiteral("arrived")}})}});
        const auto row2 = JValue::object({{QStringLiteral("id"), QStringLiteral("server-2")}, {QStringLiteral("recordVersion"), 1},
                                         {QStringLiteral("data"), JValue::object({{QStringLiteral("title"), QStringLiteral("arrived later")}})}});
        const int n = count.load();
        const auto items = n == 0 ? JValue::array() : n == 1 ? JValue::array({row}) : JValue::array({row, row2});
        return JValue::object({{QStringLiteral("items"), items}, {QStringLiteral("total"), n}});
      }
      return h.be.handle(r);
    });
    QVERIFY(h.up());
    auto* v = qobject_cast<AppViewModel*>(h.shell->appView(QStringLiteral("rec-app")));
    QVERIFY(v);
    QTRY_COMPARE(v->mode(), QStringLiteral("records"));
    QTRY_VERIFY(!v->recordState().value(QStringLiteral("loading")).toBool());
    auto* model = qobject_cast<QAbstractItemModel*>(v->records());
    QVERIFY(model);
    QCOMPARE(model->rowCount(), 0);
    v->openCreate();
    v->setDraft(QStringLiteral("title"), QStringLiteral("keep my unsaved input"));
    count = 1;
    QMetaObject::invokeMethod(h.gw->gw, "sendEvent", Qt::BlockingQueuedConnection, Q_ARG(QString, WS_A), Q_ARG(qint64, 0),
                              Q_ARG(QString, QStringLiteral("event.gap")), Q_ARG(agentos::JValue, JValue::object()));
    QTRY_COMPARE(model->rowCount(), 1);
    QCOMPARE(v->recordFormField(QStringLiteral("title")).value(QStringLiteral("value")).toString(), QStringLiteral("keep my unsaved input"));
    count = 2;
    const auto hint = JValue::object({{QStringLiteral("appId"), QStringLiteral("rec-app")}, {QStringLiteral("source"), QStringLiteral("record.created")}});
    QMetaObject::invokeMethod(h.gw->gw, "sendEvent", Qt::BlockingQueuedConnection, Q_ARG(QString, WS_A), Q_ARG(qint64, 11),
                              Q_ARG(QString, QStringLiteral("workspace.state_changed")), Q_ARG(agentos::JValue, hint));
    QTRY_COMPARE(model->rowCount(), 2);
    QVERIFY(v->recordState().value(QStringLiteral("formOpen")).toBool());
    QCOMPARE(v->recordFormField(QStringLiteral("title")).value(QStringLiteral("value")).toString(), QStringLiteral("keep my unsaved input"));
  }

  void ambiguousMembershipEventFencesThenChecksTheCurrentOwner() {
    bool received = false, fenced = false;
    Harness h;
    QVERIFY(h.up());
    connect(h.shell->rpc(), &RpcClient::eventReceived, this, [&](const RpcEvent& e) {
      if (e.type == QLatin1String("membership.revoking")) { received = true; fenced = !h.shell->canWrite(false); }
    });
    QMetaObject::invokeMethod(h.gw->gw, "sendEvent", Qt::BlockingQueuedConnection, Q_ARG(QString, WS_A), Q_ARG(qint64, 11),
                              Q_ARG(QString, QStringLiteral("membership.revoking")), Q_ARG(agentos::JValue, JValue::object()));
    QTRY_VERIFY(received);
    QVERIFY(fenced);  // an old event without a subject must not be silently ignored
    QTRY_VERIFY(h.shell->canWrite(false));  // only a fresh native membership result can restore this owner
  }

  void oldMembershipReplyCannotUndoANewerFenceOrGrantViewerWrites() {
    Harness h;
    QVERIFY(h.up());
    QTest::qWait(100);
    h.gw->gw->setHandler([&](const JValue& r) {
      if (r.get(QStringLiteral("methodId")).str() == QLatin1String("workspaces.list")) return JValue::missing();
      return h.be.handle(r);
    });
    const int before = h.sent(QStringLiteral("workspaces.list")).size();
    QMetaObject::invokeMethod(h.gw->gw, "sendEvent", Qt::BlockingQueuedConnection, Q_ARG(QString, WS_A), Q_ARG(qint64, 11),
                              Q_ARG(QString, QStringLiteral("workspace.state_changed")), Q_ARG(agentos::JValue, JValue::object()));
    QTRY_VERIFY(h.sent(QStringLiteral("workspaces.list")).size() > before);
    const QString oldId = h.sent(QStringLiteral("workspaces.list")).last().get(QStringLiteral("requestId")).str();
    QMetaObject::invokeMethod(h.gw->gw, "sendEvent", Qt::BlockingQueuedConnection, Q_ARG(QString, WS_A), Q_ARG(qint64, 12),
                              Q_ARG(QString, QStringLiteral("membership.revoking")), Q_ARG(agentos::JValue, JValue::object()));
    QTRY_VERIFY(h.sent(QStringLiteral("workspaces.list")).size() > before + 1);
    const QString freshId = h.sent(QStringLiteral("workspaces.list")).last().get(QStringLiteral("requestId")).str();
    const int late = h.shell->transportStats().value(QStringLiteral("lateDropped")).toInt();
    const auto owner = JValue::object({{QStringLiteral("items"), JValue::array({JValue::object({{QStringLiteral("workspaceId"), WS_A}, {QStringLiteral("role"), QStringLiteral("owner")}})})}});
    QMetaObject::invokeMethod(h.gw->gw, "reply", Qt::BlockingQueuedConnection, Q_ARG(QString, oldId), Q_ARG(agentos::JValue, owner));
    QTRY_VERIFY(h.shell->transportStats().value(QStringLiteral("lateDropped")).toInt() > late);
    QVERIFY(!h.shell->canWrite(false));
    const auto viewer = JValue::object({{QStringLiteral("items"), JValue::array({JValue::object({{QStringLiteral("workspaceId"), WS_A}, {QStringLiteral("role"), QStringLiteral("viewer")}})})}});
    QMetaObject::invokeMethod(h.gw->gw, "reply", Qt::BlockingQueuedConnection, Q_ARG(QString, freshId), Q_ARG(agentos::JValue, viewer));
    QTest::qWait(100);
    QVERIFY(!h.shell->canWrite(false));
    QCOMPARE(h.shell->workspaceId(), WS_A);
  }

  void eventGapTriggersSnapshotThenResubscribe() {
    Harness h;
    QVERIFY(h.up());
    QTRY_VERIFY(h.sent(QStringLiteral("events.subscribe")).size() >= 1);
    const int attaches = h.sent(QStringLiteral("workspaces.attach")).size();
    const int subs = h.sent(QStringLiteral("events.subscribe")).size();
    QMetaObject::invokeMethod(h.gw->gw, "sendEvent", Qt::BlockingQueuedConnection, Q_ARG(QString, WS_A), Q_ARG(qint64, 15), Q_ARG(QString, QStringLiteral("operation.state_changed")), Q_ARG(agentos::JValue, JValue::object()));
    QTRY_VERIFY_WITH_TIMEOUT(h.sent(QStringLiteral("workspaces.attach")).size() > attaches, 5000);
    QTRY_VERIFY_WITH_TIMEOUT(h.sent(QStringLiteral("events.subscribe")).size() > subs, 5000);
    // order: the snapshot (attach) precedes the new subscription
    int lastAttach = -1, lastSub = -1, i = 0;
    for (const auto& r : h.gw->gw->requests()) {
      if (r.get(QStringLiteral("methodId")).str() == QLatin1String("workspaces.attach")) lastAttach = i;
      if (r.get(QStringLiteral("methodId")).str() == QLatin1String("events.subscribe")) lastSub = i;
      i++;
    }
    QVERIFY(lastAttach < lastSub);
    // membership revocation for me stops writes
    QMetaObject::invokeMethod(h.gw->gw, "sendEvent", Qt::BlockingQueuedConnection, Q_ARG(QString, WS_A), Q_ARG(qint64, 11), Q_ARG(QString, QStringLiteral("membership.revoking")), Q_ARG(agentos::JValue, JValue::object({{QStringLiteral("userId"), QStringLiteral("u-alice")}})));
    QTRY_VERIFY(h.shell->writesStopped());
    QVERIFY(!h.shell->canWrite(false));
  }

  void roundedSolidStyleAndDangerConfirmDefaultCancelFocus() {
    Harness h;
    QVERIFY(h.up());
    h.view->view.requestActivate();
    // 1. Modern minimalist rounded solid style: no blur/shader effects anywhere, rounded controls/cards/modals
    int blurEffects = 0;
    walkItems(h.view->root(), [&](QQuickItem* item) {
      const QString cls = QString::fromLatin1(item->metaObject()->className());
      if (cls.contains(QLatin1String("ShaderEffect")) || cls.contains(QLatin1String("MultiEffect")) || cls.contains(QLatin1String("Blur"))) ++blurEffects;
    });
    QCOMPARE(blurEffects, 0);
    QQuickItem* submitBtn = h.find(QStringLiteral("intentSubmit"));
    QVERIFY(submitBtn);
    if (QObject* bg = submitBtn->property("background").value<QObject*>()) {
      QVERIFY(bg->property("radius").toDouble() >= 10.0);
      QCOMPARE(bg->property("color").value<QColor>().alpha(), 255);
    }
    const QImage homeShot = h.view->shot(QStringLiteral("rounded-solid-home.png"));
    const auto nearRgb = [](const QColor& a, int r, int g, int b, int d = 6) {
      return std::abs(a.red() - r) <= d && std::abs(a.green() - g) <= d && std::abs(a.blue() - b) <= d;
    };
    // The desktop frame the VM pixel checks read (os/tests m5/m19/m20 dock()): the top bar is the desktop colour
    // (#F3F3F1) with an empty right edge; a white dock sits centred at the bottom with four equal places, the
    // current one (桌面) filled #EAEAE7 near its top edge.
    QVERIFY(nearRgb(homeShot.pixelColor(homeShot.width() - 4, 3), 0xf3, 0xf3, 0xf1));
    QVERIFY(nearRgb(homeShot.pixelColor(homeShot.width() - 12, 12), 0xf3, 0xf3, 0xf1));
    QVERIFY(nearRgb(homeShot.pixelColor(3, homeShot.height() - 6), 0xf3, 0xf3, 0xf1));
    QQuickItem* dock = h.find(QStringLiteral("dock"));
    QVERIFY(dock && reallyVisible(dock));
    const QRectF dr = dock->mapRectToScene(dock->boundingRect());
    QVERIFY2(std::abs(dr.center().x() - homeShot.width() / 2.0) <= 2 && dr.bottom() > homeShot.height() - 40, qPrintable(QStringLiteral("%1,%2 %3x%4").arg(dr.x()).arg(dr.y()).arg(dr.width()).arg(dr.height())));
    QVERIFY(nearRgb(homeShot.pixelColor(int(dr.center().x()), int(dr.top()) + 3), 255, 255, 255));
    int places = 0;
    for (const char* n : {"nav:home", "nav:app", "nav:tasks", "nav:settings"}) {
      QQuickItem* it = h.find(QString::fromLatin1(n));
      QVERIFY2(it && reallyVisible(it), n);
      const QRectF r = it->mapRectToScene(it->boundingRect());
      QVERIFY2(dr.contains(r), n);
      const QColor c = homeShot.pixelColor(int(r.center().x()), int(r.top()) + 3);
      if (QByteArray(n) == "nav:home") QVERIFY2(nearRgb(c, 0xea, 0xea, 0xe7), qPrintable(c.name()));
      else QVERIFY2(nearRgb(c, 255, 255, 255), qPrintable(QString::fromLatin1(n) + c.name()));
      ++places;
    }
    QCOMPARE(places, 4);

    // 2. Red danger button requires secondary confirmation with default focus on "取消"; Enter on default focus cancels
    h.click(QStringLiteral("nav:hardware"));
    QTRY_VERIFY(h.find(QStringLiteral("powerReboot")) && h.find(QStringLiteral("powerReboot"))->isEnabled());
    const int plansBefore = h.sent(QStringLiteral("machine.actions.plan")).size();
    h.click(QStringLiteral("powerReboot"));
    QQuickItem* sure = h.find(QStringLiteral("dangerSure"));
    QQuickItem* sureCancel = h.find(QStringLiteral("dangerSureCancel"));
    QQuickItem* sureAccept = h.find(QStringLiteral("dangerSureAccept"));
    QVERIFY(sure && sureCancel && sureAccept && reallyVisible(sure));
    QTRY_COMPARE(h.view->view.activeFocusItem(), sureCancel);
    // Pressing Return when default focus is on "取消" dismisses the modal without planning the action
    QTest::keyClick(&h.view->view, Qt::Key_Return);
    QTRY_VERIFY(!sure->isVisible());
    QCOMPARE(h.sent(QStringLiteral("machine.actions.plan")).size(), plansBefore);

    // 3. Inline record delete confirmation also places default focus on "取消"
    auto* rec = qobject_cast<AppViewModel*>(h.shell->appView(QStringLiteral("rec-app")));
    QVERIFY(rec);
    QTRY_COMPARE(rec->mode(), QStringLiteral("records"));
    h.gw->gw->setHandler([&](const JValue& r) {
      if (r.get(QStringLiteral("body")).get(QStringLiteral("routeId")).str() == QLatin1String("apps.records.list")) {
        const auto row = JValue::object({{QStringLiteral("id"), QStringLiteral("r-del-1")}, {QStringLiteral("recordVersion"), 1},
                                        {QStringLiteral("data"), JValue::object({{QStringLiteral("title"), QStringLiteral("to-delete")}})}});
        return JValue::object({{QStringLiteral("items"), JValue::array({row})}, {QStringLiteral("total"), 1}});
      }
      return h.be.handle(r);
    });
    h.shell->openApp(QStringLiteral("rec-app"));
    QTRY_COMPARE(h.shell->currentPage(), QStringLiteral("app"));
    rec->setSearch(QString());
    QTRY_COMPARE(static_cast<RecordsModel*>(rec->records())->rows(), 1);
    rec->askDelete(0);
    QTRY_VERIFY(rec->recordState().value(QStringLiteral("hasDelete")).toBool());
    QQuickItem* recCancel = h.find(QStringLiteral("recordDeleteCancel"));
    QVERIFY(recCancel && reallyVisible(recCancel));
    QTRY_COMPARE(h.view->view.activeFocusItem(), recCancel);
    QTest::keyClick(&h.view->view, Qt::Key_Return);
    QTRY_VERIFY(!rec->recordState().value(QStringLiteral("hasDelete")).toBool());
  }
};

QTEST_MAIN(FlowsTest)
#include "flows_test.moc"
