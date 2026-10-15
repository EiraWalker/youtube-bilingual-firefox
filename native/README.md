# Windows 字幕缓存组件

用于 Firefox 扩展 0.4.0 的自定义字幕缓存目录写入与回读。普通双语字幕不依赖本组件；没有点击“缓存字幕”时，字幕只保留在浏览器会话内。

需要 Windows、Firefox 142+ 和 Python 3.10+。组件使用 Python 标准库，无需安装 Python 包。

在本目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

默认安装到当前用户 LocalAppData 下的 YouTubeBilingualCache，注册到当前用户的 Firefox Native Messaging Hosts；不需要管理员权限。可通过 `-PythonExecutable` 指定 Python 可执行文件，通过 `-InstallDirectory` 指定组件安装位置。

安装后打开扩展设置，填写本机缓存文件夹的绝对路径并保存。点击播放器“双语字幕”旁的“缓存字幕”，保存当时已有的字幕及译文；再次点击可合并更新。暂停或未完成的字幕也能保存，不会启动全片翻译。

点击设置中的“打开缓存文件夹”即可定位文件。每个缓存身份拥有一个稳定目录，其中 `current.json` 指向当前修订目录；该目录包含：

- `subtitles.json`：扩展后续复用的版本化结构数据。
- `original.srt`：完整源字幕。
- `bilingual.partial.srt`：已有译文对应的部分双语字幕；全部译文可用时为 `bilingual.srt`。零译文快照没有双语文件。

保留结构文件和对应目录关系，重启后扩展会按视频、源内容及翻译配置回读匹配缓存。移动缓存后，在设置中改为新位置。更改目录不会自动移动或删除旧文件。

卸载组件：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
```

自定义安装位置时传入相同的 `-InstallDirectory`。卸载只删除组件自身的三个文件和匹配的注册项，字幕缓存保留。

缓存数据不含 API Key。组件只允许本扩展连接，读写限定在已配置目录下的字幕缓存身份目录；不提供网页文件访问或任意命令执行入口。传输分块并校验完整性，每份结构数据上限 64 MiB。
