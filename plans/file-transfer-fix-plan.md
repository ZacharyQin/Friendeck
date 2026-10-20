# 文件传输功能修复计划

## 问题描述

在 Friendeck 插件的文件传输 Tab 中，点击添加文件按钮后：
- 系统文件选择框正常弹出
- 选择文件后，已选文件列表不显示
- 传输按钮仍处于不可用状态

## 问题分析

### 调试日志信息
- `x9_picker_result` 已触发 → 文件选择器链路正常
- `q5_enter len=1` → 入队函数收到了 1 个对象
- `q5_item` 显示：
  - `has_bytes=true` → 对象有字节数据
  - `has_name=false` → 路径/文件名提取失败
  - `d_len=0` → 路径为空

### 代码分析

#### 1. 文件选择器流程 ([`main.dart.js`](defaults/remote_web_ui/main.dart.js:49441))

```
用户点击选择文件 → x9() → FX() → 创建 input[type=file] → 
用户选择文件 → change 事件 → ah0.$1() → 读取文件 → ah3.$1() → $4() → 
创建 PlatformFile → 返回 FilePickerResult → q5() 入队
```

#### 2. 关键代码位置

**文件处理函数 `$4`** ([`main.dart.js:49505-49514`](defaults/remote_web_ui/main.dart.js:49505)):
```javascript
$4(a,b,c,d){var s,r,q,p,o,n=b!=null
if(n&&!B.H.gaj(b)){s=v.G
r=new s.Blob(A.b([b],t.vs),{type:a.type})
q=s.URL.createObjectURL(r)}else q=null  // ← 问题点：如果 gaj(b) 返回 true，q 为 null
s=this.b
p=a.name
o=c==null?q:c  // ← c 是 null，所以 o = q = null
s.push(new A.lH(o,p,b,d,n?b.length:a.size))
```

**入队函数 `q5`** ([`main.dart.js:102565-102630`](defaults/remote_web_ui/main.dart.js:102565)):
```javascript
// 尝试获取路径
b=c.a  // PlatformFile.a = path
if((b==null||B.b.bl(b).length===0)&&c.uri!=null)b=c.uri
if((b==null||B.b.bl(b).length===0)&&c.h!=null){...}
d=B.b.bl(b==null?"":b)

// 关键过滤条件
if(J.cO(d)!==0){...}  // ← 如果 d 为空，整个条目被跳过！
```

#### 3. 根本原因

`B.H.gaj(b)` 是检查 Uint8Array 是否为空的函数（[`main.dart.js:42850`](defaults/remote_web_ui/main.dart.js:42850)）：
```javascript
gaj(a){return a.length===0}
```

问题在于 `ah3.$1` 调用 `$4` 时：
```javascript
r.b.$4(r.c, s, q, q)  // 第3个参数 c = null
```

在 `$4` 中：
- `c = null`，所以 `o = c == null ? q : c = q`
- 如果 `B.H.gaj(b)` 返回 true（bytes 为空），则 `q = null`
- 导致 `PlatformFile.a` (path) = null

**但是**，根据调试日志 `has_bytes=true`，bytes 是存在的。这说明问题可能是：
1. `B.H.gaj(b)` 的判断逻辑有问题，或者
2. bytes 存在但长度为 0

## 修复方案

### 方案 A：修改 `$4` 函数（推荐）

**位置**: [`main.dart.js:49505-49506`](defaults/remote_web_ui/main.dart.js:49505)

**修改前**:
```javascript
$4(a,b,c,d){var s,r,q,p,o,n=b!=null
if(n&&!B.H.gaj(b)){s=v.G
```

**修改后**:
```javascript
$4(a,b,c,d){var s,r,q,p,o,n=b!=null
if(n){s=v.G
```

**原理**: 移除 `!B.H.gaj(b)` 条件，确保只要 bytes 存在就创建 blob URL。

### 方案 B：修改 `q5` 函数的入队逻辑

**位置**: [`main.dart.js:102609-102630`](defaults/remote_web_ui/main.dart.js:102609)

在 path 为空但 bytes 存在时，从 bytes 创建 blob URL。

**修改前** (第 102609 行附近):
```javascript
if(c==null){s=4
break}
```

**修改后**:
```javascript
if(c==null){s=4
break}
// 如果 path 为空但 bytes 存在，创建 blob URL
if((c.a==null||B.b.bl(c.a).length===0)&&c.c!=null){
  var _blob=new v.G.Blob(A.b([c.c],t.vs),{type:"application/octet-stream"});
  c.a=v.G.URL.createObjectURL(_blob);
}
```

### 方案 C：同时修改两处（最保险）

同时应用方案 A 和方案 B，确保在任何情况下都能正确处理文件。

## 推荐方案

**推荐使用方案 A**，因为：
1. 修改最小，只需删除一个条件
2. 从源头解决问题
3. 不会影响其他逻辑

## 具体修改步骤

### 步骤 1：备份原文件
```bash
cp defaults/remote_web_ui/main.dart.js defaults/remote_web_ui/main.dart.js.bak
```

### 步骤 2：修改 main.dart.js

找到第 49506 行：
```javascript
if(n&&!B.H.gaj(b)){s=v.G
```

修改为：
```javascript
if(n){s=v.G
```

### 步骤 3：测试验证

1. 重新加载插件
2. 打开文件传输 Tab
3. 点击选择文件按钮
4. 选择一个或多个文件
5. 验证文件是否显示在已选列表中
6. 验证传输按钮是否可用
7. 尝试上传文件，验证功能正常

## 风险评估

- **风险等级**: 低
- **影响范围**: 仅影响文件选择器的 blob URL 创建逻辑
- **回滚方案**: 恢复备份文件

## 注意事项

1. 由于源码已丢失，只能修改编译后的 JavaScript 代码
2. 修改后的代码在 Flutter 重新编译时会被覆盖
3. 建议将此修复记录下来，以便将来重建源码时参考
