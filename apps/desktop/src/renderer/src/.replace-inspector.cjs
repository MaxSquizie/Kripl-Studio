const fs = require("fs");
const pjoin = (...a) => a.join("/");

let src = fs.readFileSync(pjoin(__dirname, "App.tsx"), "utf8");
const CRLF = "\r\n";

const startMarker = "        <aside className=\"inspector\">";
const i = src.indexOf(startMarker);
if (i < 0) { console.error("START NOT FOUND"); process.exit(1); }
const closeMarker = CRLF + "        </aside>";
const asideClose = src.indexOf(closeMarker, i);
if (asideClose < 0) { console.error("CLOSE NOT FOUND"); process.exit(1); }
const end = asideClose + closeMarker.length;
if (src.slice(end, end + CRLF.length + "      </div>".length) !== CRLF + "      </div>") {
  console.error("DIV MISMATCH:", JSON.stringify(src.slice(end, end + 20)));
  process.exit(1);
}
const fullEnd = end + CRLF.length + "      </div>".length;

function lines(arr) { return arr.join(CRLF); }

const replacement = lines([
  "      </div>",
  "",
  "      {settingsOpen && (",
  "        <div className=\"interaction-backdrop\" role=\"presentation\" onClick={() => setSettingsOpen(false)}>",
  "          <section",
  "            className=\"settings-dialog\"",
  "            role=\"dialog\"",
  "            aria-modal=\"true\"",
  "            onClick={(event) => event.stopPropagation()}",
  "          >",
  "            <div className=\"settings-heading\">",
  "              <h3>Settings</h3>",
  "              <button",
  "                type=\"button\"",
  "                className=\"icon-button settings-close\"",
  "                title=\"Close settings\"",
  "                onClick={() => setSettingsOpen(false)}",
  "              >",
  "                ×",
  "              </button>",
  "            </div>",
  "",
  "            <ContextInspectorCard",
  "              snapshot={contextSnapshot}",
  "              onRetrieve={retrieveMemory}",
  "            />",
  "",
  "            <GitStatusCard",
  "              status={gitStatus}",
  "              repository={Boolean(workspace?.gitRepository)}",
  "              onCommit={commitWorkspaceChanges}",
  "            />",
  "",
  "            <div className=\"status-card\">",
  "              <span className=\"eyebrow\">Local model server</span>",
  "              <label className=\"endpoint-field\">",
  "                <span>OpenAI-compatible endpoint</span>",
  "                <input",
  "                  value={endpoint}",
  "                  onChange={(event) => setEndpoint(event.target.value)}",
  "                  spellCheck={false}",
  "                  placeholder={DEFAULT_LOCAL_ENDPOINT}",
  "                />",
  "              </label>",
  "              <button",
  "                className=\"probe-button\"",
  "                type=\"button\"",
  "                disabled={probe.status === \"checking\"}",
  "                onClick={() => void probeModels()}",
  "              >",
  "                {probe.status === \"checking\" ? \"Checking…\" : \"Connect local server\"}",
  "              </button>",
  "",
  "              {probe.status === \"idle\" && <p className=\"probe-result\">Default: LM Studio on port 1234.</p>}",
  "              {probe.status === \"error\" && <p className=\"probe-result error\">{probe.message}</p>}",
  "              {probe.status === \"ready\" && probe.models.length === 0 && (",
  "                <p className=\"probe-result\">Server is reachable, but it reports no loaded models.</p>",
  "              )}",
  "              {probe.status === \"ready\" && probe.models.length > 0 && (",
  "                <>",
  "                  <p className=\"probe-result ready\">{probe.models.length} local model(s) found.</p>",
  "                  <select",
  "                    className=\"model-select\"",
  "                    value={selectedModel}",
  "                    onChange={(event) => setSelectedModel(event.target.value)}",
  "                  >",
  "                    {probe.models.map((model) => (",
  "                      <option key={model.id} value={model.id}>",
  "                        {model.name}",
  "                      </option>",
  "                    ))}",
  "                  </select>",
  "                </>",
  "              )}",
  "            </div>",
  "",
  "            <div className=\"status-card\">",
  "              <span className=\"eyebrow\">Desktop</span>",
  "              <p className=\"detail\">{appInfo ? `${appInfo.name} ${appInfo.version}` : \"Loading…\"}</p>",
  "              <p className=\"detail\">{appInfo?.platform ?? \"—\"}</p>",
  "            </div>",
  "",
  "            <div className=\"status-card\">",
  "              <span className=\"eyebrow\">Next</span>",
  "              <ol>",
  "                <li>Add local checkpoints/worktree experiments and richer editor ergonomics.</li>",
  "              </ol>",
  "            </div>",
  "          </section>",
  "        </div>",
  "      )}"
]);

src = src.slice(0, i) + replacement + src.slice(fullEnd);
fs.writeFileSync(pjoin(__dirname, "App.tsx"), src);
console.log("OK: inspector replaced with settings dialog");
