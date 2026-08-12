import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { api } from "../../api";
import { useStore } from "../../store";
import type { Settings } from "../../types";
import { FAMILY_CONFIG, PID_VAE_FORMATS } from "../../config/families";
import {
	DEFAULT_SD_PORT,
	MAX_SD_PORT,
	MIN_SD_PORT,
	formatError,
	modelFileOptionLabel,
	normalizeSdPort,
} from "../../lib/utils";
import {
	buildLaunchConfig,
	findModelField,
	inferPidVaeFormat,
	persistFamilyDefaults,
	validateMaxVramSpec,
} from "../../lib/launchConfig";
import { Panel } from "../ui/Panel";
import { IC } from "../ui/Icons";
import { Logo } from "../ui/Logo";
import { NumberInput } from "../ui/NumberInput";
import { Select } from "../ui/Select";
import { Toggle } from "../ui/Toggle";
import { TwoTapButton } from "../ui/TwoTapButton";
import { useModelSwitch } from "../../hooks/useModelSwitch";
import { cn } from "../ui/cn";

export function Dashboard() {
	const settings = useStore((s) => s.settings);
	const setSettings = useStore((s) => s.setSettings);
	const serverStatus = useStore((s) => s.serverStatus);
	const caps = useStore((s) => s.caps);
	const jobs = useStore((s) => s.jobs);
	const results = useStore((s) => s.results);
	const scanResult = useStore((s) => s.scanResult);
	const setScanResult = useStore((s) => s.setScanResult);
	const mainModel = useStore((s) => s.mainModel);
	const setMainModel = useStore((s) => s.setMainModel);
	const familyOverride = useStore((s) => s.familyOverride);
	const setFamilyOverride = useStore((s) => s.setFamilyOverride);
	const components = useStore((s) => s.components);
	const setComponents = useStore((s) => s.setComponents);
	const toast = useStore((s) => s.toast);
	const setDashboardOpen = useStore((s) => s.setDashboardOpen);
	const [starting, setStarting] = useState(false);
	// 切换模型将影响任务/结果时的待确认影响清单;非空即显示确认条
	const [pendingSwitch, setPendingSwitch] = useState<string[] | null>(null);
	const {
		switchModel,
		switching: switchingModel,
		phase: switchPhase,
	} = useModelSwitch();
	const [scanning, setScanning] = useState(false);
	const [scanError, setScanError] = useState("");
	const [settingsState, setSettingsState] = useState<
		"loading" | "saved" | "saving" | "error"
	>("loading");
	const scanRequest = useRef(0);
	// 磁盘设置是否已加载完成：加载完成前禁止自动保存，否则挂载瞬间会把
	// 初始空 settings 写盘，与 loadSettings 竞争，可能覆盖掉用户的配置文件。
	const settingsLoaded = useRef(false);

	useEffect(() => {
		api
			.loadSettings()
			.then((s) => {
				const { loadWarning, ...persisted } = s;
				useStore.setState({ settings: persisted });
				settingsLoaded.current = true;
				if (loadWarning) {
					setSettingsState("error");
					toast(
						`${loadWarning.message}${
							loadWarning.backupPath
								? `；原文件已备份到 ${loadWarning.backupPath}`
								: ""
						}`,
						true,
					);
				} else {
					setSettingsState("saved");
				}
			})
			.catch((e) => {
				settingsLoaded.current = true;
				setSettingsState("error");
				toast("设置加载失败: " + formatError(e), true);
			});
	}, [toast]);

	// 卸载时冲刷未落盘的设置。防抖（400ms）期间的变更——典型如切换模型
	// 成功后写入的模型快照——会随 Dashboard 卸载（切回生成界面）被
	// clearTimeout 丢弃：这正是"启动成功出图了、快照却没记录"的根因。
	const pendingSettingsSave = useRef<Settings | null>(null);

	useEffect(() => {
		if (!settingsLoaded.current) return;
		// 防抖：路径输入框每敲一个字符都会触发本 effect，不能每次都写盘。
		pendingSettingsSave.current = settings;
		const t = setTimeout(() => {
			pendingSettingsSave.current = null;
			setSettingsState("saving");
			api
				.saveSettings(settings)
				.then(() => setSettingsState("saved"))
				.catch((e) => {
					setSettingsState("error");
					toast("设置保存失败: " + formatError(e), true);
				});
		}, 400);
		return () => clearTimeout(t);
	}, [settings]);

	// 卸载时冲刷未落盘的设置（pendingSettingsSave 非空说明防抖定时器还没
	// 触发过）。fire-and-forget：invoke 在组件卸载后仍会完成。
	useEffect(() => {
		return () => {
			const pending = pendingSettingsSave.current;
			pendingSettingsSave.current = null;
			if (pending) void api.saveSettings(pending).catch(() => {});
		};
	}, []);

	useEffect(() => {
		const requestId = ++scanRequest.current;
		setMainModel("");
		setFamilyOverride("");
		setComponents(() => ({}));
		setScanResult(null);
		setScanError("");
		if (!settings.modelDir.trim()) {
			setScanning(false);
			return;
		}
		const dir = settings.modelDir.trim();
		const timer = setTimeout(() => {
			setScanning(true);
			api
				.scanModels(dir)
				.then((result) => {
					if (scanRequest.current !== requestId) return;
					setScanResult(result);
					setScanning(false);
				})
				.catch((e) => {
					if (scanRequest.current !== requestId) return;
					const message = formatError(e);
					setScanError(message);
					setScanning(false);
					toast("扫描失败: " + message, true);
				});
		}, 450);
		return () => {
			clearTimeout(timer);
			if (scanRequest.current === requestId) setScanning(false);
		};
	}, [
		settings.modelDir,
		setComponents,
		setFamilyOverride,
		setMainModel,
		setScanResult,
		toast,
	]);

	const files = scanResult?.files ?? [];
	const scanFamilies = scanResult?.families ?? {};
	// 主模型只能从扫描结果（category=model）中选出，scanFamilies（Rust 端
	// detect_family 的结果）必有对应条目；不再保留前端正则回退。
	const detectedFamily = mainModel
		? familyOverride || scanFamilies[mainModel] || "custom"
		: "";
	const familyConfig = detectedFamily ? FAMILY_CONFIG[detectedFamily] : null;
	// The "主模型" picker already selects the primary model file, so it doubles
	// as the family's main model arg (--diffusion-model for split families, -m
	// for single-file). The matching field is hidden from the component panel so
	// users don't have to pick the same file twice.
	const modelField = familyConfig ? findModelField(familyConfig) : null;
	const modelCandidates = files.filter((f) => f.category === "model");
	const mainModelDir = mainModel
		? files.find((f) => f.path === mainModel)?.dir
		: undefined;

	const getOptions = (cat: string) => files.filter((f) => f.category === cat);

	useEffect(() => {
		if (!mainModel || !familyConfig) return;
		setComponents((current) => {
			const next: Record<string, string> = {};
			for (const field of familyConfig.fields) {
				if (field.key === modelField?.key) continue;
				const candidates = files.filter((f) => f.category === field.cat);
				const currentValid = candidates.some(
					(f) => f.path === current[field.key],
				);
				if (currentValid) {
					next[field.key] = current[field.key];
					continue;
				}
				const sameDir = candidates.filter((f) => f.dir === mainModelDir);
				if (sameDir.length === 1) next[field.key] = sameDir[0].path;
				else if (candidates.length === 1) next[field.key] = candidates[0].path;
			}
			return next;
		});
	}, [
		detectedFamily,
		familyConfig,
		files,
		mainModel,
		mainModelDir,
		modelField?.key,
		setComponents,
	]);

	const launchPreview =
		familyConfig && mainModel
			? buildLaunchConfig({
					family: detectedFamily,
					modelPath: mainModel,
					components,
					runtime: settings,
					modelDir: settings.modelDir,
				})
			: null;
	const missingRequirements = launchPreview?.missing || [];
	// GO/NO-GO 检查单:能否发射只取决于这三件事实
	const pathsReady = settings.modelDir.trim().length > 0;
	const modelReady = mainModel.length > 0;
	const familyUnsupported = Boolean(familyConfig?.unsupported);
	const componentsReady =
		modelReady &&
		familyConfig !== null &&
		!familyUnsupported &&
		missingRequirements.length === 0;
	const readyCount = [pathsReady, modelReady, componentsReady].filter(
		Boolean,
	).length;
	const allReady = readyCount === 3;
	const mainModelName = mainModel
		? (files.find((f) => f.path === mainModel)?.name ??
			mainModel.split(/[\\/]/).pop())
		: "";
	const pathsSection = useRef<HTMLDivElement>(null);
	const modelSection = useRef<HTMLDivElement>(null);
	const componentsSection = useRef<HTMLDivElement>(null);
	const revealSection = (ref: { current: HTMLElement | null }) => {
		const el = ref.current;
		if (!el) return;
		el.scrollIntoView({ behavior: "smooth", block: "start" });
		// 先移除再强制回流后重加,让闪烁动画可以重复触发
		el.classList.remove("section-flash");
		void el.offsetWidth;
		el.classList.add("section-flash");
	};

	const browse = async (key: "exeDir" | "modelDir" | "outputDir") => {
		const p = key === "exeDir" ? await api.pickFile() : await api.pickFolder();
		if (p) setSettings((s) => ({ ...s, [key]: p }));
	};

	/** 当前模型的启动配置快照（与历史字段保持一致）。 */
	const buildSnapshot = () => ({
		familyOverride,
		components: { ...components },
		backend: settings.backend,
		refImagePreset: settings.refImagePreset,
		vaeFormat: settings.vaeFormat || "",
		extraArgs: settings.extraArgs,
		offloadCpu: settings.offloadCpu,
		quantType: settings.quantType,
		maxVram: settings.maxVram || "",
		maxQueueSize: settings.maxQueueSize,
	});

	const selectMainModel = (path: string) => {
		setPendingSwitch(null);
		setMaxVramModePick(null);
		setMainModel(path);
		const snapshot = path ? settings.modelSnapshots?.[path] : undefined;
		if (!snapshot) {
			setFamilyOverride("");
			setComponents(() => ({}));
			const detected = path ? scanFamilies[path] : "";
			setSettings((current) => ({
				...current,
				vaeFormat: detected === "pid" ? inferPidVaeFormat(path) : "",
			}));
			return;
		}
		setFamilyOverride(snapshot.familyOverride);
		setComponents(() => ({ ...snapshot.components }));
		const snapshotFamily = snapshot.familyOverride || scanFamilies[path] || "";
		setSettings((current) => ({
			...current,
			backend: snapshot.backend,
			refImagePreset: snapshot.refImagePreset,
			vaeFormat:
				snapshot.vaeFormat ||
				(snapshotFamily === "pid" ? inferPidVaeFormat(path) : ""),
			extraArgs: snapshot.extraArgs,
			offloadCpu: snapshot.offloadCpu,
			quantType: snapshot.quantType,
			maxVram: snapshot.maxVram || "",
			maxQueueSize: snapshot.maxQueueSize,
		}));
		toast("已恢复该模型上次启动配置");
	};

	const saveModelSnapshot = () => {
		if (!mainModel) return;
		const current = useStore.getState().settings;
		const next: Settings = {
			...current,
			modelSnapshots: {
				...(current.modelSnapshots || {}),
				[mainModel]: buildSnapshot(),
			},
		};
		setSettings(() => next);
		// 立即落盘，不等 400ms 防抖：切换模型路径中本函数之后紧跟
		// setDashboardOpen(false)（Dashboard 卸载），防抖定时器会被卸载
		// 清理掉，快照整个丢失（RedCraft-V3 一直没进快照的直接原因）。
		void api.saveSettings(next).catch(() => {});
	};

	// 主模型选中/组件配置/家族覆盖变化即记录当前模型快照：旧设计只在启动
	// 成功后记录，用户配置了组件但没启动（或启动失败）就切换/关闭时，
	// 配置永远丢失——"选中后组件配置没有记录并沿用"的另一半根因。
	useEffect(() => {
		if (!mainModel || !settingsLoaded.current) return;
		setSettings((current) => ({
			...current,
			modelSnapshots: {
				...(current.modelSnapshots || {}),
				[mainModel]: buildSnapshot(),
			},
		}));
		// 只依赖这三者：settings 本身每帧变化（后端/端口等），不必跟随。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mainModel, components, familyOverride]);

	// 端口输入允许中途处于空/越界状态，落到启动与展示时统一夹回合法区间。
	const sdPort = normalizeSdPort(settings.sdPort);

	// --max-vram 的原始 spec 即设置中存的字符串，界面模式由此推导：
	// 空 = 不传；含 "=" = 按设备自定义；负值 = 自动探测保留余量；其余 = 固定预算。
	const maxVramRaw = (settings.maxVram || "").trim();
	const maxVramDerived =
		maxVramRaw === ""
			? "unset"
			: maxVramRaw.includes("=")
				? "custom"
				: maxVramRaw.startsWith("-")
					? "auto"
					: "fixed";
	// 手动选择的模式需要粘住：自定义模式下清空输入时值为空，纯推导会掉回
	// "不限"导致输入框消失。快照恢复/换模型时重置回推导（见 selectMainModel）。
	const [maxVramModePick, setMaxVramModePick] = useState<string | null>(null);
	const maxVramMode = maxVramModePick ?? maxVramDerived;
	// 切换模式时尽量保留同模式下的已有数值，避免来回切换丢掉输入。
	const setMaxVramMode = (mode: string) => {
		setMaxVramModePick(mode === "unset" ? null : mode);
		setSettings((s) => {
			const raw = (s.maxVram || "").trim();
			let maxVram = "";
			if (mode === "fixed") maxVram = /^\d+(\.\d+)?$/.test(raw) ? raw : "6";
			else if (mode === "auto")
				maxVram = /^-\d+(\.\d+)?$/.test(raw) ? raw : "-2";
			else if (mode === "custom") maxVram = raw.includes("=") ? raw : "";
			return { ...s, maxVram };
		});
	};

	const startServer = async (confirmed = false) => {
		if (!mainModel) {
			toast("请先选择模型", true);
			return;
		}
		if (!familyConfig) {
			toast("无法识别模型类型", true);
			return;
		}
		if (familyConfig.unsupported) {
			toast(familyConfig.unsupported, true);
			return;
		}
		if (missingRequirements.length > 0) {
			toast("缺少必需配置: " + missingRequirements.join("、"), true);
			return;
		}
		// --max-vram 自由文本预校验：非法 spec 会让 sd-server 启动即退，
		// 在这里给出可读错误而不是事后翻日志（对抗性审查 A3）。
		const maxVramError = validateMaxVramSpec(settings.maxVram || "");
		if (maxVramError) {
			toast("显存预算（--max-vram）格式无效：" + maxVramError, true);
			return;
		}
		if (serverStatus?.reachable) {
			if (serverStatus.external) {
				toast(
					"当前连接的是外部 sd-server，请先在外部停止服务后再更换模型",
					true,
				);
				return;
			}
			if (caps?.model?.path === mainModel) {
				setDashboardOpen(false);
				return;
			}
			const activeJobs = jobs.filter(
				(job) =>
					job.status === "queued" ||
					job.status === "generating" ||
					job.status === "unknown",
			).length;
			const unsavedResults = results.filter(
				(result) => result.saveStatus !== "saved",
			).length;
			const impacts = [
				activeJobs > 0 ? `${activeJobs} 个活动任务` : "",
				unsavedResults > 0 ? `${unsavedResults} 个尚未安全保存的结果` : "",
			].filter(Boolean);
			if (impacts.length > 0 && !confirmed) {
				setPendingSwitch(impacts);
				return;
			}
			setPendingSwitch(null);
			setStarting(true);
			try {
				const switched = await switchModel(mainModel);
				if (switched) {
					saveModelSnapshot();
					setDashboardOpen(false);
				}
			} finally {
				setStarting(false);
			}
			return;
		}
		setStarting(true);
		try {
			const launch = buildLaunchConfig({
				family: detectedFamily,
				modelPath: mainModel,
				components,
				runtime: settings,
				modelDir: settings.modelDir,
			});
			if (launch.missing.length > 0) {
				toast("缺少必需配置: " + launch.missing.join("、"), true);
				return;
			}
			// 目录还是完整可执行文件路径都原样交给 Rust 端解析（is_file 探测），
			// 这里不做平台相关的拼接（"\\sd-server.exe" 会破坏 Linux/macOS）。
			const exePath = settings.exeDir || "sd-server";
			await api.startServer(
				exePath,
				familyConfig.name,
				launch.mode,
				launch.args,
				sdPort,
			);
			saveModelSnapshot();
			persistFamilyDefaults(familyConfig);
			toast("服务器启动中...");
		} catch (e) {
			toast("启动失败: " + formatError(e), true);
		} finally {
			setStarting(false);
		}
	};

	const stopServer = async () => {
		try {
			const result = await api.stopServer();
			if (!result.stopped && !result.alreadyStopped) {
				throw new Error("未能确认服务器已经停止");
			}
			toast("已停止");
		} catch (e) {
			toast("停止失败: " + formatError(e), true);
		}
	};

	const running = serverStatus?.running ?? false;
	const external = serverStatus?.external ?? false;
	// 停止服务器 = 卸载模型：进行中/排队中的任务会随服务器内存一起蒸发，
	// 存在活动任务时必须两段式确认（对抗性审查 B3）。
	const activeJobsCount = jobs.filter(
		(job) =>
			job.status === "queued" ||
			job.status === "generating" ||
			job.status === "unknown",
	).length;
	// 安全灯 orb 的四种活法:灭(未运行)/闪烁(启动中)/长明(就绪)/警示(失败)
	const orbState = running
		? serverStatus?.phase === "failed"
			? "failed"
			: serverStatus?.reachable
				? "ready"
				: "starting"
		: external
			? "ready"
			: "offline";

	return (
		<div className="dashboard">
			<motion.div
				className="dash-rail"
				initial={{ opacity: 0, y: 16 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
			>
				<div className="logo-row">
					<Logo size={30} />
					<div>
						<div className="wordmark">流光</div>
						<div className="hero-en">LUMINA STUDIO</div>
					</div>
				</div>
				<div className="orb-wrap">
					<span className={cn("orb", orbState)} aria-hidden="true" />
					<div className="orb-info">
						<div className="model-name">
							{running
								? serverStatus?.model || "sd-server"
								: serverStatus?.external
									? "外部 sd-server"
									: "未运行"}
						</div>
						<div className="status-text">
							{running
								? serverStatus?.phase === "failed"
									? `启动失败：${serverStatus.lastError || "请查看日志"}`
									: serverStatus?.reachable
										? "就绪"
										: serverStatus?.phase === "starting"
											? "正在加载模型…"
											: "正在启动…"
								: serverStatus?.external
									? "就绪（外部进程）"
									: "等待启动"}
						</div>
					</div>
					<div className="orb-actions">
						{external && (
							<span className="tag" style={{ fontSize: 11, opacity: 0.7 }}>
								外部进程
							</span>
						)}
						{serverStatus?.reachable && (
							<button
								className="btn btn-sm"
								onClick={() => setDashboardOpen(false)}
							>
								进入生成界面
							</button>
						)}
					</div>
				</div>
				<div className="check-list">
					<div className="check-head">
						启动检查
						<span className={cn("check-summary", allReady && "ready")}>
							{allReady ? "READY · 可以启动" : `待完成 ${3 - readyCount} 项`}
						</span>
					</div>
					<button
						type="button"
						className={cn("check-item", pathsReady && "done")}
						onClick={() => revealSection(pathsSection)}
					>
						<span className="check-dot" aria-hidden="true" />
						<span className="check-label">路径</span>
						<span className="check-detail">
							{!pathsReady
								? "未设置模型目录"
								: scanning
									? "扫描中…"
									: files.length
										? `${files.length} 个模型文件`
										: "目录已设置"}
						</span>
					</button>
					<button
						type="button"
						className={cn("check-item", modelReady && "done")}
						onClick={() => revealSection(modelReady ? modelSection : pathsSection)}
					>
						<span className="check-dot" aria-hidden="true" />
						<span className="check-label">主模型</span>
						<span className="check-detail">
							{modelReady ? mainModelName : "等待选择"}
						</span>
					</button>
					<button
						type="button"
						className={cn("check-item", componentsReady && "done")}
						onClick={() =>
							revealSection(modelReady ? componentsSection : pathsSection)
						}
					>
						<span className="check-dot" aria-hidden="true" />
						<span className="check-label">组件</span>
						<span
							className={cn(
								"check-detail",
								modelReady &&
									(missingRequirements.length > 0 || familyUnsupported) &&
									"warn",
							)}
						>
							{!modelReady
								? "随主模型检测"
								: familyUnsupported
									? "暂不支持"
									: missingRequirements.length > 0
										? `缺 ${missingRequirements.length} 项`
										: "齐备"}
						</span>
					</button>
				</div>

				<div className={cn("launch-dock", allReady && "ready")}>
					{pendingSwitch && (
						<div className="confirm-strip" role="alert">
							<span className="confirm-strip-text">
								切换模型将停止当前服务：{pendingSwitch.join("、")}
							</span>
							<span className="confirm-strip-actions">
								<button
									className="btn btn-sm"
									onClick={() => setPendingSwitch(null)}
								>
									取消
								</button>
								<button
									className="btn btn-sm btn-danger"
									onClick={() => startServer(true)}
									disabled={starting || switchingModel}
								>
									确认切换
								</button>
							</span>
						</div>
					)}
					{mainModel &&
						familyConfig &&
						missingRequirements.length > 0 &&
						!familyUnsupported && (
							<div className="validation-summary" role="alert">
								还缺 {missingRequirements.length} 个必需配置：
								{missingRequirements.join("、")}
							</div>
						)}
					{mainModel && familyConfig?.unsupported && (
						<div className="validation-summary" role="alert">
							{familyConfig.unsupported}
						</div>
					)}
					{mainModel && familyConfig && (
						<div className="launch-meta">
							{familyConfig.name} ·{" "}
							{launchPreview?.mode === "vid_gen" ? "视频生成" : "图像生成"}
						</div>
					)}
					<div className="launch-row">
						<button
							className="btn btn-primary btn-launch"
							onClick={() => startServer()}
							disabled={
								!mainModel ||
								!familyConfig ||
								familyUnsupported ||
								starting ||
								switchingModel ||
								missingRequirements.length > 0
							}
						>
							{starting || switchingModel ? (
								<>
									<span className="spinner" />
									{switchPhase === "preflight"
										? "正在检查模型…"
										: switchPhase === "stopping"
											? "正在停止当前模型…"
											: switchPhase === "rollback"
												? "正在恢复上一个模型…"
												: serverStatus?.reachable
													? "正在切换模型…"
													: "启动中…"}
								</>
							) : (
								<>
									{IC.play}
									{serverStatus?.reachable
										? caps?.model?.path === mainModel
											? "返回生成界面"
											: "切换到此模型"
										: "启动服务器"}
								</>
							)}
						</button>
						{running && !external && (
							<TwoTapButton
								className="btn btn-danger"
								label="停止服务器"
								armedLabel={`确认停止（${activeJobsCount} 个任务将丢失）`}
								armedTitle="停止服务器会卸载模型并丢失进行中的任务，再次点击确认"
								needsConfirm={activeJobsCount > 0}
								onConfirm={() => void stopServer()}
								idle={<>{IC.power} 停止</>}
								armed="确认?"
							/>
						)}
					</div>
				</div>

				<div className="rail-keys" aria-hidden="true">
					<span>
						<span className="kbd">Ctrl + Enter</span> 提交生成
					</span>
					<span>
						<span className="kbd">Ctrl + ,</span> 参数面板
					</span>
					<span>
						<span className="kbd">Esc</span> 关闭浮层
					</span>
				</div>
			</motion.div>

			<motion.div
				className="dashboard-card"
				initial={{ opacity: 0, y: 16 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1], delay: 0.08 }}
			>
				<div className={cn("settings-state", settingsState)} role="status">
					{settingsState === "loading"
						? "正在读取设置…"
						: settingsState === "saving"
							? "正在保存设置…"
							: settingsState === "error"
								? "设置未保存，请检查配置目录权限"
								: "设置已保存"}
				</div>

				<div ref={pathsSection}>
				<Panel title="程序与路径">
					<div className="field-row">
						<label className="form-label" htmlFor="dashboard-server-exe">
							{IC.box} sd-server
						</label>
						<input
							id="dashboard-server-exe"
							className="input"
							type="text"
							value={settings.exeDir}
							onChange={(e) =>
								setSettings((s) => ({ ...s, exeDir: e.target.value }))
							}
							placeholder="可留空从 PATH 查找，或选择 sd-server 可执行文件"
						/>
						<button
							className="icon-btn"
							title="浏览..."
							onClick={() => browse("exeDir")}
						>
							{IC.folder}
						</button>
					</div>
					<div className="field-hint">
						sd-server 可执行文件；留空时从 PATH 查找
					</div>
					<div className="field-row">
						<label className="form-label" htmlFor="dashboard-model-dir">
							{IC.folder} 模型目录
						</label>
						<input
							id="dashboard-model-dir"
							className="input"
							type="text"
							value={settings.modelDir}
							onChange={(e) =>
								setSettings((s) => ({ ...s, modelDir: e.target.value }))
							}
							placeholder="例如 D:\models"
						/>
						<button
							className="icon-btn"
							title="浏览..."
							onClick={() => browse("modelDir")}
						>
							{IC.folder}
						</button>
					</div>
					<div className="field-hint">
						{scanning
							? `正在扫描：${settings.modelDir}`
							: scanError
								? `扫描失败：${scanError}`
								: files.length
									? `已发现 ${files.length} 个文件${scanResult?.truncated ? "（结果已截断）" : ""}`
									: settings.modelDir
										? "扫描完成，未发现支持的模型文件"
										: "扫描模型文件的根目录"}
					</div>
					{!!scanResult?.warnings?.length && (
						<div className="scan-warning" role="alert">
							扫描部分完成：
							{scanResult.warnings
								.slice(0, 3)
								.map((warning) => warning.message)
								.join("；")}
							{scanResult.warnings.length > 3
								? `；另有 ${scanResult.warnings.length - 3} 项警告`
								: ""}
						</div>
					)}
					<div className="field-row">
						<label className="form-label" htmlFor="dashboard-output-dir">
							{IC.folder} 输出目录
						</label>
						<input
							id="dashboard-output-dir"
							className="input"
							type="text"
							value={settings.outputDir}
							onChange={(e) =>
								setSettings((s) => ({ ...s, outputDir: e.target.value }))
							}
							placeholder="例如 D:\output（留空则不自动保存）"
						/>
						<button
							className="icon-btn"
							title="浏览..."
							onClick={() => browse("outputDir")}
						>
							{IC.folder}
						</button>
					</div>
					<div className="field-hint">生成图片/视频的保存路径</div>
				</Panel>
				</div>

				<div ref={modelSection}>
				{(files.length > 0 || scanning) && (
					<Panel title="模型检测">
						{scanning ? (
							<div className="empty-state">
								<span className="spinner" /> 正在扫描模型…
							</div>
						) : modelCandidates.length === 0 ? (
							<div className="empty-state">
								发现了文件，但没有可作为主模型的候选项
							</div>
						) : (
							<>
								<div className="form-row">
									<label className="form-label" htmlFor="dashboard-main-model">
										主模型
									</label>
									<Select
										id="dashboard-main-model"
										value={mainModel}
										onChange={selectMainModel}
										options={[
											{ value: "", label: "-- 选择模型 --" },
											...modelCandidates.map((f) => ({
												value: f.path,
												label: modelFileOptionLabel(f),
											})),
										]}
									/>
								</div>
								{mainModel && detectedFamily && (
									<div className="form-row" style={{ marginTop: 8 }}>
										<label className="form-label" htmlFor="dashboard-family">
											识别类型
										</label>
										<Select
											id="dashboard-family"
											value={familyOverride || detectedFamily}
											onChange={(next) => {
												setFamilyOverride(next);
												if (next === "pid" && !settings.vaeFormat) {
													setSettings((current) => ({
														...current,
														vaeFormat: inferPidVaeFormat(mainModel),
													}));
												}
											}}
											options={Object.entries(FAMILY_CONFIG).map(([k, v]) => ({
												value: k,
												label: v.unsupported
													? `${v.name}（暂不支持）`
													: v.name,
											}))}
										/>
										{familyConfig && (
											<span className="tag" style={{ marginLeft: 4 }}>
												{familyConfig.hint}
											</span>
										)}
									</div>
								)}
							</>
						)}
					</Panel>
				)}
				</div>

				<div ref={componentsSection}>
				{mainModel && familyConfig && (
					<>
						{familyConfig.fields.filter((f) => f.key !== modelField?.key)
							.length > 0 && (
							<Panel title={`组件配置 — ${familyConfig.name}`}>
								{familyConfig.fields
									.filter((field) => field.key !== modelField?.key)
									.map((field) => {
										const opts = getOptions(field.cat);
										const val = components[field.key] || "";
										return (
											<div key={field.key} className="form-row">
												<label
													className="form-label"
													htmlFor={`component-${field.key}`}
												>
													{field.label}
												</label>
												<Select
													id={`component-${field.key}`}
													value={val}
													onChange={(v) =>
														setComponents((c) => ({
															...c,
															[field.key]: v,
														}))
													}
													options={[
														{
															value: "",
															label:
																field.required && detectedFamily !== "custom"
																	? "-- 必需，尚未设置 --"
																	: "-- 未设置（可选） --",
														},
														...opts.map((f) => ({
															value: f.path,
															label:
																modelFileOptionLabel(f) +
																(f.dir !== mainModelDir
																	? " — " + f.dir.split("/").pop()
																	: ""),
														})),
													]}
												/>
											</div>
										);
									})}
								{detectedFamily === "pid" && (
									<div className="form-row">
										<label
											className="form-label"
											htmlFor="component-pid-vae-format"
										>
											VAE 格式
										</label>
										<Select
											id="component-pid-vae-format"
											value={settings.vaeFormat || ""}
											onChange={(v) =>
												setSettings((current) => ({
													...current,
													vaeFormat: v,
												}))
											}
											options={[
												{ value: "", label: "-- 必需，请匹配 PiD 模型 --" },
												...PID_VAE_FORMATS.map((option) => ({
													value: option.value,
													label: `${option.label}（${option.value}）`,
												})),
											]}
										/>
										<div className="field-hint" style={{ margin: "2px 0 0 0" }}>
											{settings.vaeFormat
												? "必须与 PiD checkpoint 使用的 VAE latent 布局一致"
												: "无法从文件名可靠确定，请按模型卡选择对应格式"}
										</div>
									</div>
								)}
							</Panel>
						)}
					</>
				)}
				</div>

				<div className="config-group-label">高级配置</div>

				<Panel title="运行后端" collapsed>
					<div className="form-row">
						<label className="form-label" htmlFor="dashboard-backend-preset">
							后端预设
						</label>
						<Select
							id="dashboard-backend-preset"
							value={settings.backend || "auto"}
							onChange={(v) =>
								setSettings((s) => ({
									...s,
									backend: v === "auto" ? "" : v,
								}))
							}
							options={[
								{ value: "auto", label: "自动（默认）" },
								{ value: "gpu", label: "首个可用 GPU" },
								{ value: "cuda0", label: "CUDA" },
								{ value: "rocm", label: "AMD ROCm / HIP" },
								{ value: "vulkan0", label: "Vulkan" },
								{ value: "cpu", label: "仅 CPU" },
								// 自定义 --backend 值不在预设中时回显为"自定义",避免触发器空态
								...(settings.backend &&
								!["gpu", "cuda0", "rocm", "vulkan0", "cpu"].includes(
									settings.backend,
								)
									? [
											{
												value: settings.backend,
												label: `自定义（${settings.backend}）`,
											},
										]
									: []),
							]}
						/>
					</div>
					<div className="form-row" style={{ marginTop: 8 }}>
						<label className="form-label" htmlFor="dashboard-backend-custom">
							自定义 --backend
						</label>
						<input
							id="dashboard-backend-custom"
							className="input"
							type="text"
							value={settings.backend}
							onChange={(e) =>
								setSettings((s) => ({ ...s, backend: e.target.value }))
							}
							placeholder="例如 cuda0 或 clip=cpu,vae=cuda0,diffusion=vulkan0"
						/>
						<div className="field-hint" style={{ margin: "2px 0 0 0" }}>
							支持组件级分配，如 clip=cpu,diffusion=cuda0
						</div>
					</div>
				</Panel>

				<Panel title="参考图处理" collapsed>
					<div className="form-row">
						<label className="form-label" htmlFor="dashboard-ref-image-preset">
							处理预设
						</label>
						<Select
							id="dashboard-ref-image-preset"
							value={settings.refImagePreset}
							onChange={(v) =>
								setSettings((s) => ({ ...s, refImagePreset: v }))
							}
							options={[
								{ value: "", label: "自动检测（推荐）" },
								{ value: "flux_kontext", label: "Flux Kontext" },
								{ value: "longcat", label: "LongCat Edit" },
								{ value: "qwen", label: "Qwen Image Edit" },
								{ value: "qwen_layered", label: "Qwen Image Layered" },
								{ value: "mage_flow", label: "Mage-Flow Edit" },
								{ value: "flux2", label: "Flux 2" },
								{ value: "z_image_omni", label: "Boogu / Z-Image Omni" },
								{ value: "krea2_ostris_edit", label: "Krea2 Ostris Edit" },
								{ value: "krea2_edit", label: "Krea2 Edit 768" },
								{ value: "cosmos_reference", label: "Anima / Cosmos Reference" },
							]}
						/>
						<div className="field-hint" style={{ margin: "2px 0 0 0" }}>
							作为 --ref-image-args preset=… 在模型启动时传给
							sd-server；通常保持自动即可
						</div>
						{(detectedFamily === "krea2" ||
							detectedFamily === "krea2-turbo") && (
							<div className="field-hint" style={{ margin: "4px 0 0 0" }}>
								Krea2 自动模式使用 Ostris Edit；仅 lbouaraba/krea2edit
								一类模型选择 “Krea2 Edit 768”
							</div>
						)}
					</div>
				</Panel>

				<Panel title="性能与显存" collapsed>
					<div className="form-row">
						<Toggle
							label="CPU 卸载（--offload-to-cpu）"
							checked={settings.offloadCpu}
							onChange={(v) =>
								setSettings((s) => ({ ...s, offloadCpu: v }))
							}
						/>
						<div className="field-hint" style={{ margin: "2px 0 0 0" }}>
							将部分层卸载到 CPU 以节省显存，适合低显存跑大模型
						</div>
					</div>
					<div className="form-row" style={{ marginTop: 8 }}>
						<label className="form-label" htmlFor="dashboard-max-vram-mode">
							显存预算（--max-vram）
						</label>
						{/* form-row 是块级布局，Select 触发器 width:100%——联动输入框必须与
						    Select 包进同一个 flex 容器，否则会换行并带着 margin 错位。 */}
						<div className="flex items-center gap-2">
							<Select
								id="dashboard-max-vram-mode"
								className="flex-1"
								value={maxVramMode}
								onChange={setMaxVramMode}
								options={[
									{ value: "unset", label: "不限（默认，不传该参数）" },
									{ value: "fixed", label: "固定预算（GiB）" },
									{ value: "auto", label: "自动探测（保留空闲余量）" },
									{ value: "custom", label: "按设备自定义" },
								]}
							/>
							{maxVramMode === "fixed" && (
								<NumberInput
									id="dashboard-max-vram-fixed"
									style={{ width: 96, flexShrink: 0 }}
									value={Number(maxVramRaw) || 0}
									min={0}
									max={256}
									step={0.5}
									onChange={(v) =>
										setSettings((s) => ({ ...s, maxVram: String(v) }))
									}
									ariaLabel="显存预算 GiB"
								/>
							)}
							{maxVramMode === "auto" && (
								<NumberInput
									id="dashboard-max-vram-reserve"
									style={{ width: 96, flexShrink: 0 }}
									value={Math.abs(Number(maxVramRaw)) || 2}
									min={0.5}
									max={64}
									step={0.5}
									onChange={(v) =>
										setSettings((s) => ({ ...s, maxVram: String(-v) }))
									}
									ariaLabel="保留的空闲显存 GiB"
								/>
							)}
							{maxVramMode === "custom" && (
								<input
									id="dashboard-max-vram-custom"
									className="input flex-1"
									type="text"
									style={{ minWidth: 0 }}
									value={settings.maxVram || ""}
									onChange={(e) =>
										setSettings((s) => ({ ...s, maxVram: e.target.value }))
									}
									placeholder="例如 cuda0=6,vulkan0=4"
									aria-label="按设备自定义显存预算"
								/>
							)}
						</div>
						<div className="field-hint" style={{ margin: "2px 0 0 0" }}>
							{maxVramMode === "unset" &&
								"不传 --max-vram：不做图切分预算，引擎使用全部可用显存"}
							{maxVramMode === "fixed" &&
								"图切分分段执行的显存上限（GiB）；0 = 禁用图切分"}
							{maxVramMode === "auto" &&
								"自动探测空闲显存并保留指定余量（以负值传给 --max-vram）"}
							{maxVramMode === "custom" &&
								"按后端/设备分别指定预算（GiB），逗号分隔"}
						</div>
					</div>
					<div className="form-row" style={{ marginTop: 8 }}>
						<label className="form-label" htmlFor="dashboard-quant-type">
							加载时量化（--type）
						</label>
						<Select
							id="dashboard-quant-type"
							value={settings.quantType}
							onChange={(v) =>
								setSettings((s) => ({ ...s, quantType: v }))
							}
							options={[
								{ value: "", label: "不量化（默认）" },
								// 常用 K 量化（注意：无 _S/_M 配方区分，见下方说明）
								{ value: "q4_K", label: "Q4_K（推荐）" },
								{ value: "q5_K", label: "Q5_K" },
								{ value: "q6_K", label: "Q6_K" },
								{ value: "q8_K", label: "Q8_K" },
								{ value: "q3_K", label: "Q3_K" },
								{ value: "q2_K", label: "Q2_K" },
								// 传统均匀量化
								{ value: "q8_0", label: "Q8_0" },
								{ value: "q8_1", label: "Q8_1" },
								{ value: "q5_0", label: "Q5_0" },
								{ value: "q5_1", label: "Q5_1" },
								{ value: "q4_0", label: "Q4_0" },
								{ value: "q4_1", label: "Q4_1" },
								// IQ 系列（需 imatrix 才有可用质量）
								{ value: "iq4_xs", label: "IQ4_XS（需 imatrix）" },
								{ value: "iq4_nl", label: "IQ4_NL（需 imatrix）" },
								{ value: "iq3_s", label: "IQ3_S（需 imatrix）" },
								{ value: "iq3_xxs", label: "IQ3_XXS（需 imatrix）" },
								{ value: "iq2_s", label: "IQ2_S（需 imatrix）" },
								{ value: "iq2_xs", label: "IQ2_XS（需 imatrix）" },
								{ value: "iq2_xxs", label: "IQ2_XXS（需 imatrix）" },
								{ value: "iq1_s", label: "IQ1_S（需 imatrix）" },
								{ value: "iq1_m", label: "IQ1_M（需 imatrix）" },
								// 无损转换
								{ value: "f16", label: "F16" },
								{ value: "f32", label: "F32" },
							]}
						/>
						<div className="field-hint" style={{ margin: "2px 0 0 0" }}>
							Q4_K 等 K 量化不区分 _S/_M 配方；混合精度（如视觉塔保
							F16）需在附加启动参数写 --tensor-type-rules
						</div>
					</div>
					<div className="form-row" style={{ marginTop: 8 }}>
						<label className="form-label" htmlFor="dashboard-extra-args">
							附加启动参数
						</label>
						<input
							id="dashboard-extra-args"
							className="input"
							type="text"
							value={settings.extraArgs}
							onChange={(e) =>
								setSettings((s) => ({ ...s, extraArgs: e.target.value }))
							}
							placeholder="例如 --threads 8 --mmap --stream-layers"
						/>
						<div className="field-hint" style={{ margin: "2px 0 0 0" }}>
							原样拼接到 sd-server 命令行，兜底所有未在界面暴露的参数
						</div>
					</div>
					<div className="form-row" style={{ marginTop: 8 }}>
						<label className="form-label" htmlFor="dashboard-max-queue">
							最大队列
						</label>
						<NumberInput
							id="dashboard-max-queue"
							style={{ width: 80 }}
							value={settings.maxQueueSize ?? 4}
							min={1}
							max={32}
							onChange={(value) =>
								setSettings((s) => ({ ...s, maxQueueSize: value }))
							}
							ariaLabel="最大队列数量"
						/>
						<div className="field-hint" style={{ margin: "2px 0 0 0" }}>
							生成队列上限（服务器未提供时生效）
						</div>
					</div>
					<div className="form-row" style={{ marginTop: 8 }}>
						<label className="form-label" htmlFor="dashboard-sd-port">
							启动端口
						</label>
						<NumberInput
							id="dashboard-sd-port"
							style={{ width: 96 }}
							value={sdPort}
							min={MIN_SD_PORT}
							max={MAX_SD_PORT}
							onChange={(value) =>
								setSettings((s) => ({ ...s, sdPort: value }))
							}
							ariaLabel="sd-server 启动端口"
						/>
						<div className="field-hint" style={{ margin: "2px 0 0 0" }}>
							sd-server 监听 127.0.0.1 的端口，默认 {DEFAULT_SD_PORT}；范围{" "}
							{MIN_SD_PORT}–{MAX_SD_PORT}
							{running && sdPort !== serverStatus?.sdPort
								? `。当前服务器运行在 ${serverStatus?.sdPort}，重启后改用新端口`
								: ""}
						</div>
					</div>
				</Panel>

				</motion.div>
		</div>
	);
}
