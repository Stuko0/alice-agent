export namespace main {
	
	export class ConnectionConfig {
	    mode: string;
	    remoteUrl: string;
	    remoteToken: string;
	    remoteAuthMode: string;
	    profile: string;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.mode = source["mode"];
	        this.remoteUrl = source["remoteUrl"];
	        this.remoteToken = source["remoteToken"];
	        this.remoteAuthMode = source["remoteAuthMode"];
	        this.profile = source["profile"];
	    }
	}
	export class ConnectionInfo {
	    baseUrl: string;
	    wsUrl: string;
	    token: string;
	    authMode: string;
	    mode: string;
	    isFullscreen: boolean;
	    nativeOverlayWidth: number;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.baseUrl = source["baseUrl"];
	        this.wsUrl = source["wsUrl"];
	        this.token = source["token"];
	        this.authMode = source["authMode"];
	        this.mode = source["mode"];
	        this.isFullscreen = source["isFullscreen"];
	        this.nativeOverlayWidth = source["nativeOverlayWidth"];
	    }
	}
	export class DesktopVersionInfo {
	    appVersion: string;
	    electronVersion: string;
	    nodeVersion: string;
	    platform: string;
	    aliceRoot: string;
	
	    static createFrom(source: any = {}) {
	        return new DesktopVersionInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.appVersion = source["appVersion"];
	        this.electronVersion = source["electronVersion"];
	        this.nodeVersion = source["nodeVersion"];
	        this.platform = source["platform"];
	        this.aliceRoot = source["aliceRoot"];
	    }
	}
	export class ProbeResult {
	    reachable: boolean;
	    authMode: string;
	    version: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new ProbeResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.reachable = source["reachable"];
	        this.authMode = source["authMode"];
	        this.version = source["version"];
	        this.error = source["error"];
	    }
	}
	export class ProxyApiRequest {
	    path: string;
	    method: string;
	    body: string;
	
	    static createFrom(source: any = {}) {
	        return new ProxyApiRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.method = source["method"];
	        this.body = source["body"];
	    }
	}
	export class ProxyApiResponse {
	    status: number;
	    body: string;
	
	    static createFrom(source: any = {}) {
	        return new ProxyApiResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.status = source["status"];
	        this.body = source["body"];
	    }
	}
	export class SelectPathsRequest {
	    title: string;
	    defaultPath: string;
	    directories: boolean;
	    multiple: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SelectPathsRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.title = source["title"];
	        this.defaultPath = source["defaultPath"];
	        this.directories = source["directories"];
	        this.multiple = source["multiple"];
	    }
	}
	export class TerminalSession {
	    ID: string;
	    Shell: string;
	    Cwd: string;
	    Cols: number;
	    Rows: number;
	
	    static createFrom(source: any = {}) {
	        return new TerminalSession(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ID = source["ID"];
	        this.Shell = source["Shell"];
	        this.Cwd = source["Cwd"];
	        this.Cols = source["Cols"];
	        this.Rows = source["Rows"];
	    }
	}
	export class UpdateApplyOptions {
	    branch: string;
	
	    static createFrom(source: any = {}) {
	        return new UpdateApplyOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.branch = source["branch"];
	    }
	}
	export class UpdateApplyResult {
	    ok: boolean;
	    manual?: boolean;
	    command?: string;
	    guiSkew?: boolean;
	    manualRestart?: boolean;
	    handedOff?: boolean;
	    error?: string;
	    message?: string;
	
	    static createFrom(source: any = {}) {
	        return new UpdateApplyResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ok = source["ok"];
	        this.manual = source["manual"];
	        this.command = source["command"];
	        this.guiSkew = source["guiSkew"];
	        this.manualRestart = source["manualRestart"];
	        this.handedOff = source["handedOff"];
	        this.error = source["error"];
	        this.message = source["message"];
	    }
	}
	export class UpdateStatus {
	    supported: boolean;
	    branch: string;
	    currentBranch?: string;
	    behind: number;
	    currentSha?: string;
	    targetSha?: string;
	    commits: any[];
	    dirty: boolean;
	    updateAvailable: boolean;
	    error?: string;
	    reason?: string;
	    message?: string;
	    aliceRoot?: string;
	    fetchedAt: number;
	
	    static createFrom(source: any = {}) {
	        return new UpdateStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.supported = source["supported"];
	        this.branch = source["branch"];
	        this.currentBranch = source["currentBranch"];
	        this.behind = source["behind"];
	        this.currentSha = source["currentSha"];
	        this.targetSha = source["targetSha"];
	        this.commits = source["commits"];
	        this.dirty = source["dirty"];
	        this.updateAvailable = source["updateAvailable"];
	        this.error = source["error"];
	        this.reason = source["reason"];
	        this.message = source["message"];
	        this.aliceRoot = source["aliceRoot"];
	        this.fetchedAt = source["fetchedAt"];
	    }
	}

}

