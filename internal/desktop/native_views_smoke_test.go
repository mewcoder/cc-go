//go:build native_views_smoke && !headless

package desktop

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"cc-go/internal/server"
	"cc-go/internal/sessions"
	webfiles "cc-go/web"
	"github.com/egoist/mygo"
)

// Opt-in real VSIX integration. It uses synthetic, local history in a temporary
// Claude config and never sends a prompt or touches the user's running app.
func init() {
	if os.Getenv("CC_GO_NATIVE_VSIX_SMOKE") != "1" {
		return
	}
	if err := runNativeVSIXSmoke(); err != nil {
		fmt.Println("FAIL:", err)
		os.Exit(1)
	}
	os.Exit(0)
}

func runNativeVSIXSmoke() error {
	archive := os.Getenv("CC_GO_SMOKE_VSIX")
	if archive == "" {
		return fmt.Errorf("set CC_GO_SMOKE_VSIX to a trusted local official VSIX")
	}
	dir, err := os.MkdirTemp("", "cc-go-native-vsix-")
	if err != nil {
		return err
	}
	fmt.Println("Native VSIX smoke artifacts:", dir)
	workspace := filepath.Join(dir, "workspace")
	config := filepath.Join(dir, "claude")
	projects := filepath.Join(config, "projects")
	assets := filepath.Join(dir, "web")
	data := filepath.Join(dir, "data")
	for _, path := range []string{workspace, assets, data, filepath.Join(projects, sessions.ProjectDirectory(workspace))} {
		if err := os.MkdirAll(path, 0700); err != nil {
			return err
		}
	}
	workspace, err = filepath.EvalSymlinks(workspace)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(projects, sessions.ProjectDirectory(workspace)), 0700); err != nil {
		return err
	}
	// Keep the official extension and any prewarmed executable away from real
	// credentials/history. No send/user-input action is performed by this test.
	_ = os.Setenv("CLAUDE_CONFIG_DIR", config)
	_ = os.Setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:1")
	for _, name := range []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"} {
		_ = os.Unsetenv(name)
	}
	var ids []string
	for index := range 12 {
		id := fmt.Sprintf("10000000-0000-4000-8000-%012d", index)
		ids = append(ids, id)
		userID := fmt.Sprintf("20000000-0000-4000-8000-%012d", index)
		rows := []map[string]any{
			{"type": "user", "uuid": userID, "parentUuid": nil, "sessionId": id, "cwd": workspace, "isSidechain": false, "userType": "external", "version": "2.1.34", "timestamp": "2026-10-30T01:00:00Z", "message": map[string]any{"role": "user", "content": fmt.Sprintf("Native IPC question %02d", index)}},
			{"type": "assistant", "uuid": fmt.Sprintf("30000000-0000-4000-8000-%012d", index), "parentUuid": userID, "sessionId": id, "cwd": workspace, "isSidechain": false, "userType": "external", "version": "2.1.34", "timestamp": "2026-10-30T01:00:01Z", "message": map[string]any{"id": "msg_fixture", "type": "message", "role": "assistant", "model": "claude-sonnet-4-6", "content": []map[string]string{{"type": "text", "text": fmt.Sprintf("Native IPC answer %02d", index)}}, "stop_reason": "end_turn", "stop_sequence": nil, "usage": map[string]int{"input_tokens": 10, "output_tokens": 10}}},
		}
		var transcript []byte
		for _, row := range rows {
			b, _ := json.Marshal(row)
			transcript = append(append(transcript, b...), '\n')
		}
		if err := os.WriteFile(filepath.Join(projects, sessions.ProjectDirectory(workspace), id+".jsonl"), transcript, 0600); err != nil {
			return err
		}
	}
	entries, _ := webfiles.Files.ReadDir(".")
	for _, entry := range entries {
		b, err := webfiles.Files.ReadFile(entry.Name())
		if err != nil {
			return err
		}
		if entry.Name() == "bridge.js" {
			b = append([]byte(nativeSmokeViewGuard), b...)
			b = append(b, []byte(nativeSmokeViewProbe)...)
		}
		if entry.Name() == "desktop.js" {
			b = append([]byte(nativeSmokeShellProbe), b...)
		}
		if err := os.WriteFile(filepath.Join(assets, entry.Name()), b, 0600); err != nil {
			return err
		}
	}
	state, _ := json.Marshal(map[string]any{"workspace": workspace, "workspaces": []string{workspace}, "setupComplete": true})
	if err := os.WriteFile(filepath.Join(data, "desktop.json"), state, 0600); err != nil {
		return err
	}
	backend, err := server.New(server.Config{DataDir: data, Workspace: workspace, ProjectsDir: projects, VSIX: archive, DevAssets: assets, VSCodeExtensionsDirs: []string{}})
	if err != nil {
		return err
	}
	defer backend.Close()
	if err := backend.Start(); err != nil {
		return err
	}
	var passed atomic.Bool
	var resultText atomic.Value
	mygo.App.OnWindowCreated(func(window *mygo.Window) {
		window.Page().OnDidFinishLoad(func() {
			go func() {
				defer mygo.App.Quit()
				idsJSON, _ := json.Marshal(ids)
				workspaceJSON, _ := json.Marshal(workspace)
				program := strings.ReplaceAll(strings.ReplaceAll(nativeSmokeExercise, "__IDS__", string(idsJSON)), "__WORKSPACE__", string(workspaceJSON))
				if _, err := window.Page().Eval(program); err != nil {
					resultText.Store(err.Error())
					return
				}
				deadline := time.Now().Add(150 * time.Second)
				for time.Now().Before(deadline) {
					result, err := mygo.EvalAs[struct {
						Done bool   `json:"done"`
						OK   bool   `json:"ok"`
						Text string `json:"text"`
					}](window.Page(), `window.__nativeSmoke.result || {done:false,ok:false,text:''}`)
					if err == nil && result.Done {
						if png, err := window.CapturePage(); err == nil {
							_ = os.WriteFile(filepath.Join(dir, "result.png"), png, 0600)
						}
						resultText.Store(result.Text)
						passed.Store(result.OK)
						fmt.Println(result.Text)
						return
					}
					time.Sleep(100 * time.Millisecond)
				}
				resultText.Store("timed out waiting for native multi-session exercise")
			}()
		})
	})
	if err := Run(backend); err != nil {
		return err
	}
	if !passed.Load() {
		return fmt.Errorf("native VSIX multi-session test: %v (logs in %s)", resultText.Load(), dir)
	}
	return nil
}

const nativeSmokeViewGuard = `
window.__smokeErrors=[];
window.__smokeNetwork={ws:0,sse:0,http:0};
window.WebSocket=class{constructor(){window.__smokeNetwork.ws++;throw Error('WS transport forbidden')}};
window.EventSource=class{constructor(){window.__smokeNetwork.sse++;throw Error('SSE transport forbidden')}};
const smokeFetch=window.fetch;
window.fetch=(url,...args)=>{if(/\/view\/.*\/(socket|events|message|state|external)(\?|$)/.test(String(url)))window.__smokeNetwork.http++;return smokeFetch.call(window,url,...args)};
window.addEventListener('error',event=>window.__smokeErrors.push(String(event.message)));
window.addEventListener('unhandledrejection',event=>window.__smokeErrors.push(String(event.reason)));
`

const nativeSmokeViewProbe = `
setInterval(()=>parent.postMessage({__nativeSmoke:true,id:__claudeBridge.base.split('/')[4],
  text:document.body?.innerText || '',composer:!!document.querySelector('[role="textbox"][aria-label="Message input"]'),
  initial:document.getElementById('root')?.dataset.initialSession,
  buttons:[...document.querySelectorAll('button')].map(b=>({text:b.innerText,label:b.getAttribute('aria-label'),title:b.title})),
  theme:document.body?.dataset.vscodeThemeKind,width:document.documentElement.style.getPropertyValue('--claude-host-transcript-width'),network:window.__smokeNetwork,
  native:typeof window.mygo,errors:window.__smokeErrors},__claudeBridge.shellOrigin),100);
`

const nativeSmokeShellProbe = `
window.__nativeSmoke={views:{},result:null};
window.WebSocket=window.EventSource=class{constructor(){throw Error('HTTP stream transport forbidden')}};
window.addEventListener('message',event=>{
  if(!event.data?.__nativeSmoke)return;
  const frame=[...document.querySelectorAll('iframe')].find(f=>f.contentWindow===event.source);
  if(frame && event.origin===new URL(frame.src).origin)window.__nativeSmoke.views[event.data.id]=event.data;
});
`

const nativeSmokeExercise = `
void (async()=>{
  const smoke=window.__nativeSmoke,ids=__IDS__,workspace=__WORKSPACE__;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  async function wait(check,label){const until=Date.now()+45000;while(Date.now()<until){const value=await check();if(value)return value;await sleep(100)}throw Error('timeout: '+label)}
  async function state(){return desktop.getState()}
  const api=async(method,args)=>{const r=await fetch('/api/'+method,{method:'POST',headers:{'Content-Type':'application/json','X-Claude-Desktop-Token':window.__goDesktopConfig.token},body:JSON.stringify(args)});if(!r.ok)throw Error(await r.text());return r.json()};
  try{
    await wait(async()=>{const s=await state();if(s.error)throw Error(s.error);return s.phase==='active'},'extension startup');
    const activity=s=>JSON.stringify(s.workspaces.flatMap(w=>w.sessions).filter(s=>ids.includes(s.id)).map(s=>[s.id,s.updatedAt]));
    const beforeActivity=activity(await state());
    const viewIDs=[];
    for(let i=0;i<ids.length;i++){
      await desktop.openSession(workspace,ids[i]);
      const s=await state(),active=s.views.find(v=>v.active);viewIDs.push(active.id);
      const expected='Native IPC answer '+String(i).padStart(2,'0');
      await wait(()=>smoke.views[active.id]?.text.includes(expected) && smoke.views[active.id]?.text.includes('Native IPC question '+String(i).padStart(2,'0')) && smoke.views[active.id]?.composer,'history '+i);
      const view=smoke.views[active.id];
      if(view.native!=='undefined'||view.errors.length)throw Error('iframe isolation/runtime error: '+JSON.stringify(view));
    }
    if(new Set(viewIDs).size!==12)throw Error('expected 12 independent conversation views');
    console.log('PASS: 12 official VSIX histories render both transcript and composer through native IPC');
    let blankSwitchFrames=0,watchSwitches=true;
    const sampleSwitch=()=>{if(!watchSwitches)return;const frames=[...document.querySelectorAll('iframe.go-extension-view')];if(!frames.some(f=>!f.hidden))blankSwitchFrames++;requestAnimationFrame(sampleSwitch)};
    requestAnimationFrame(sampleSwitch);
    for(const i of [0,11,1,10,2,9,3,8,4,7,5,6,0]){
      await desktop.openSession(workspace,ids[i]);
      const s=await state(),active=s.views.find(v=>v.active);
      if(active.id!==viewIDs[i])throw Error('conversation was not retained on switch');
      await wait(()=>smoke.views[active.id]?.text.includes('Native IPC answer '+String(i).padStart(2,'0')),'switch '+i);
    }
    watchSwitches=false;
    if(blankSwitchFrames)throw Error('blank frames during rapid chat switches: '+blankSwitchFrames);
    if([...document.querySelectorAll('iframe.go-extension-view')].some(f=>f.getBoundingClientRect().width===0))throw Error('retained conversation lost its layout');
    if(activity(await state())!==beforeActivity)throw Error('opening history changed message timestamps or order');
    // Force a real document reload and prove the official extension rehydrates it.
    const frame=[...document.querySelectorAll('iframe')].find(f=>new URL(f.src).pathname.split('/')[2]===viewIDs[0]);
    frame.dispatchEvent(new Event('error'));
    const failure=document.querySelector('.go-view-status');
    if(!failure||failure.hidden||!failure.innerText.includes('Could not load this chat'))throw Error('missing conversation error state');
    if([...document.querySelectorAll('iframe.go-extension-view')].some(f=>!f.hidden))throw Error('failed chat still shows stale conversation pixels');
    delete smoke.views[viewIDs[0]];
    failure.querySelector('button').click();
    await wait(()=>failure.hidden && smoke.views[viewIDs[0]]?.text.includes('Native IPC answer 00'),'retry failed conversation');
    delete smoke.views[viewIDs[0]];
    frame.src=frame.src+'&smokeReload=1';
    await wait(()=>smoke.views[viewIDs[0]]?.text.includes('Native IPC answer 00') && smoke.views[viewIDs[0]]?.composer,'document reload');
    await desktop.setTheme('light');await desktop.setTranscriptWidth('wide');
    await wait(()=>viewIDs.every(id=>smoke.views[id]?.theme==='vscode-light' && smoke.views[id]?.width==='1040px'),'background theme/width broadcast');
    for(const id of viewIDs){const view=smoke.views[id];if(view.errors.length||view.native!=='undefined'||Object.values(view.network).some(Boolean))throw Error('view runtime failure '+JSON.stringify(view))}
    await api('close',{id:viewIDs[11]});
    await wait(async()=>!(await state()).views.some(v=>v.id===viewIDs[11]),'view disposal');
    smoke.result={done:true,ok:true,text:'PASS: 12 real official VSIX histories + 13 switches + document reload + theme/width broadcast + close; isolated native IPC, no WS/SSE, no model prompt'};
  }catch(error){smoke.result={done:true,ok:false,text:String(error)+'; views='+JSON.stringify(smoke.views)}}
})();
`
