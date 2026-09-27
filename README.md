# 带壳截图

在网页里给 iOS 截图套上 Apple 官方 iPhone 边框。图片只在本机浏览器里处理，不会上传。

## 部署到 Vercel

纯静态站点，不需要构建。`vercel.json` 已经指定输出目录为 `public/`，`.vercelignore` 排除了 1.4GB 的原始 DMG。

**用命令行：**

```bash
npm i -g vercel
vercel          # 第一次会让你登录并创建项目，得到预览地址
vercel --prod   # 发布到正式地址
```

**用 GitHub：** 把项目推到 GitHub（`.gitignore` 已排除 DMG），在 Vercel 里 Import 这个仓库，框架选 Other，其余保持默认。以后每次 push 都会自动部署。

边框图片的文件名带内容哈希，线上设置了一年的强缓存；`index.html`、`app.js`、`style.css`、`devices.js` 用 Vercel 默认缓存，每次部署后立即生效。

## 本地预览

1. 双击 `start.command`，浏览器会自动打开 `http://127.0.0.1:8765/`
   （或运行 `python3 -m http.server -d public`，然后访问 `http://localhost:8000`）
2. 把截图拖进页面里的手机屏幕，或点击选择文件，也可以直接 ⌘V 粘贴，支持一次添加多张
3. 选择机型、颜色和方向，点「下载图片」，多张截图可以用「全部下载」打包成 ZIP

> 不要直接双击 `public/index.html` 打开。浏览器会禁止从本地文件导出画布，预览正常，但导出会失败。

## 功能

- **机型**：iPhone 11 到 iPhone 18 系列、iPhone Air、iPhone Duo（内屏 / 外屏 / 展开背面），共 32 个机型、182 张边框
- **颜色**：每个机型的全部官方配色
- **方向**：「自动」按截图宽高判断横竖屏。横屏可选机身顶部朝左或朝右，只有竖屏素材的旧机型会自动旋转成横屏
- **自动选机型**：截图尺寸和某个机型的屏幕一致时自动切换过去，例如 1206×2622 对应 iPhone 18 Pro / 17 Pro / 17 / 16 Pro
- **截图适配**：尺寸不一致时可以选择「填充」（裁切边缘）、「完整显示」（补黑边）或「拉伸」
- **导出**：透明、白、黑或自定义背景色，留白、阴影，原始 / 1/2 / 1/3 尺寸，PNG 或 JPG，也能复制到剪贴板

截图尺寸和屏幕一致时按原像素贴入，不做缩放。

## 目录

```
public/                           网站根目录（部署的就是这个目录）
  index.html  style.css  app.js
  assets/devices.js               设备清单（机型、颜色、屏幕位置）
  assets/bezels/                  边框 PNG（从 DMG 提取，文件名带哈希）
  assets/masks/                   屏幕区域蒙版
  llms.txt                        给 AI 搜索看的项目介绍和搜索关键词
  robots.txt                      允许搜索引擎抓取
vercel.json                       Vercel 配置（输出目录、缓存头）
.vercelignore  .gitignore         不上传 / 不提交的文件
tools/build_assets.py             从 Resources/*.dmg 生成 public/assets/
Resources/                        Apple 原始 DMG（只在本地）
start.command                     本地预览脚本
```

## 更新素材

有新的 Bezel DMG 时，放进 `Resources/`，然后重新生成：

```bash
python3 -m venv .venv
.venv/bin/pip install -r tools/requirements.txt
.venv/bin/python tools/build_assets.py
```

脚本会自动挂载 DMG（并同意其中的许可协议），提取 PNG，找出每张边框里的屏幕区域，生成蒙版和 `public/assets/devices.js`。然后重新部署即可。遇到没登记的机型或颜色时，会用自动取色并在终端提示。要调整排序、中文名或色卡，改脚本顶部的 `MODEL_ORDER` / `COLORS`。

网页底部和 `llms.txt` 里的「支持的机型」列表也由脚本生成（网页里在 `<!-- MODELS:START -->` 和 `<!-- MODELS:END -->` 之间），不要手动改。只改了中文名或色卡、不需要重新提取素材时，运行 `.venv/bin/python tools/build_assets.py --lists-only` 即可同步。

## 关于素材授权

边框素材版权归 Apple 所有，授权见 DMG 中的《App Store Marketing Artwork License Agreement》：只能用于宣传你自己在 App Store 上架的 App，不可转让，并且要求你是 Apple Developer Program 成员。公开网站会让任何人都能下载这些 PNG，超出了这个授权范围。如果只是自己或团队使用，建议在 Vercel 项目的 Settings → Deployment Protection 里开启访问保护。
