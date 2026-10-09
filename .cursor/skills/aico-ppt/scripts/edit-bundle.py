# -*- coding: utf-8 -*-
"""
edit-bundle.py — 安全编辑「独立版」单文件 deck 的工具函数。

独立版结构（约 187 行）：
  - 行 184(索引)  <script type="__bundler/manifest">  ← 上一行；行 176(索引) 是 28MB JSON dict {uuid:{mime,compressed,data(base64)}}
  - 行 184(索引)  <script type="__bundler/template"> 的内容（行 185/索引184）= 整份 deck 的 HTML，存成一个 JSON 字符串
  实际索引以代码里的探测为准（找 '<script type="__bundler/template">' 的下一行）。

铁律：
  1) 编码必须 dump_template()：json.dumps(s, ensure_ascii=False).replace('</','<\\u002F')
     —— 只转义 '</'（防 </script> 提前闭合 + 子标签）；CJK 不转义；URL 里普通 '/' 不动。
  2) 回填后断言 '</' not in raw 且 json.loads(raw)==s。
  3) 改结构必须三处同步：slide DOM / nav[] / chapters[]。下面的 insert/delete/move 已做完。
  4) data-idx 必须是数字。

典型用法：
  bundle = load(PATH); s = get_template(bundle)
  s = insert_page(s, new_block, before_label='LoRA 原理')   # 或 before_idx
  set_template(bundle, s); save(PATH, bundle); verify(PATH)
"""
import argparse, json, base64, gzip, zlib, uuid, re, os, tempfile
from os import replace as atomic_replace

# ---------------- 读写 ----------------
def load(path):
    with open(path, encoding='utf-8') as stream:
        return stream.read().split('\n')

def save(path, lines):
    _verify_lines(lines)
    target = os.path.abspath(os.fspath(path))
    directory = os.path.dirname(target)
    descriptor, temporary = tempfile.mkstemp(
        prefix='.%s.' % os.path.basename(target), suffix='.tmp', dir=directory
    )
    replaced = False
    try:
        try:
            os.chmod(temporary, os.stat(target).st_mode & 0o777)
        except FileNotFoundError:
            pass
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            descriptor = None
            stream.write('\n'.join(lines))
            stream.flush()
            os.fsync(stream.fileno())
        atomic_replace(temporary, target)
        replaced = True
        if os.name != 'nt':
            directory_fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if not replaced:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

def _tpl_idx(lines):
    for i, ln in enumerate(lines):
        if ln.strip() == '<script type="__bundler/template">':
            return i + 1
    raise RuntimeError('template script not found')

def _man_idx(lines):
    for i, ln in enumerate(lines):
        if ln.strip() == '<script type="__bundler/manifest">':
            return i + 1
    raise RuntimeError('manifest script not found')

def get_template(lines):
    return json.loads(lines[_tpl_idx(lines)].strip())

def _escape_json_surrogates(raw):
    # ensure_ascii=False 保留 CJK，但 Python 不允许把 JSON 内存中的
    # lone surrogate 直接编码为 UTF-8。只把 surrogate code unit 还原为
    # JSON \uXXXX 转义；其他中文、URL 与 / 均不变。
    return ''.join(
        '\\u%04x' % ord(char) if 0xD800 <= ord(char) <= 0xDFFF else char
        for char in raw
    )

def dump_template(s):
    raw = _escape_json_surrogates(
        json.dumps(s, ensure_ascii=False)
    ).replace('</', '<\\u002F')
    assert '\n' not in raw and '</' not in raw and json.loads(raw) == s, 'template encode invariant failed'
    return raw

def set_template(lines, s):
    lines[_tpl_idx(lines)] = dump_template(s)

def get_manifest(lines):
    return json.loads(lines[_man_idx(lines)].strip())

def set_manifest(lines, manifest):
    raw = _escape_json_surrogates(
        json.dumps(manifest, ensure_ascii=False, separators=(',', ':'))
    )
    assert '\n' not in raw and json.loads(raw) == manifest, 'manifest encode invariant failed'
    lines[_man_idx(lines)] = raw

# ---------------- 图片 / 资源 ----------------
def embed_image(lines, file_path, mime='image/jpeg', prefix='img'):
    """把图片追加进 manifest，返回可用作 <img src="..."> 的 uuid。jpg/png 用 compressed:false。"""
    b64 = base64.b64encode(open(file_path, 'rb').read()).decode('ascii')
    uid = prefix + '-' + uuid.uuid4().hex
    entry = '"%s":{"mime":"%s","compressed":false,"data":"%s"}' % (uid, mime, b64)
    mi = _man_idx(lines); mraw = lines[mi]; ms = mraw.rstrip()
    assert ms.endswith('}')
    lead = mraw[:len(mraw) - len(mraw.lstrip())]
    lines[mi] = lead + ms[:-1] + ',' + entry + '}'
    assert uid in json.loads(lines[mi].strip())
    return uid

def get_resource(lines, uid):
    """取出某 uuid 的解码字节（自动 gzip 解压 compressed:true，如内联的 React 运行时）。"""
    e = json.loads(lines[_man_idx(lines)].strip())[uid]
    raw = base64.b64decode(e['data'])
    return gzip.decompress(raw) if e.get('compressed') else raw

# ---------------- 离线内联 React（修 unpkg CDN 依赖）----------------
def inline_react(lines, react_umd_path, reactdom_umd_path):
    """把 react/react-dom UMD 作为内联 <script> 放到运行时脚本之前，使 deck 真离线。
    两个文件需是 react@18.3.1 / react-dom@18.3.1 的 UMD production；不得含字面 '</script'。"""
    s = get_template(lines)
    rt = re.search(r'<script src="[0-9a-f-]{30,}"></script>', s)
    assert rt, 'runtime <script src=UUID> not found'
    rc = open(react_umd_path, encoding='utf-8').read()
    rd = open(reactdom_umd_path, encoding='utf-8').read()
    for nm, c in [('react', rc), ('react-dom', rd)]:
        assert re.search(r'</script', c, re.I) is None, nm
    inline = ('<script>/* React UMD inlined for offline */\n' + rc + '\n</script>\n'
              '<script>/* ReactDOM UMD inlined for offline */\n' + rd + '\n</script>\n')
    s = s[:rt.start()] + inline + s[rt.start():]
    set_template(lines, s)

# ---------------- nav / chapters ----------------
def _nav_entries(s):
    ns = s.find('const nav = ['); ne = s.find('];', ns)
    ents = re.findall(r"\{ i:\d+, code:'((?:[^'\\]|\\.)*)', label:'((?:[^'\\]|\\.)*)' \}", s[ns:ne+2])
    return ns, ne, [c for c, l in ents], [l for c, l in ents]

def _write_nav(s, codes, lbls):
    ns = s.find('const nav = ['); ne = s.find('];', ns)
    body = "\n".join("      { i:%d, code:'%s', label:'%s' }," % (k, codes[k], lbls[k]) for k in range(len(codes)))
    return s[:ns] + "const nav = [\n" + body + "\n    ];" + s[ne+2:]

def bump_chapters(s, delta, after_start):
    """把 start > after_start 的所有 chapters[].start 加 delta（在某章内增删页时调用）。"""
    def repl(m):
        st = int(m.group(2))
        return m.group(1) + str(st + delta if st > after_start else st)
    return re.sub(r"(start:)(\d+)", repl, s)

# ---------------- 页块定位 ----------------
def _slide_bounds(s, label):
    i = s.find('<section data-label="%s"' % label)
    assert i > 0, label
    st = s.rfind('<div class="slide-fit"', 0, i)
    end = s.find('</div></div>', s.find('</section>', i)) + len('</div></div>')
    return st, end

PAGE_ID_RE = re.compile(r'\bdata-page-id="(page-[0-9a-f]{32})"')
SECTION_OPEN_RE = re.compile(r'<section\b(?=[^>]*\bdata-label="[^"]+")[^>]*>')
EDITOR_ID_RE = re.compile(r'\bdata-editor-id="(element-[0-9a-f]{32})"')
_EDITOR_ID_ATTRIBUTE_RE = re.compile(r'\bdata-editor-id\b', re.IGNORECASE)
_PAGE_SECTION_ATTRIBUTE_RE = re.compile(
    r'\bdata-label\s*=\s*(?:"[^"]+"|\'[^\']+\')', re.IGNORECASE
)
_EDITOR_ID_SKIP_TAGS = {
    'script', 'style', 'link', 'meta', 'title', 'base', 'br', 'wbr',
    'source', 'track', 'area', 'col', 'embed', 'param',
}

def page_ids(s):
    """按页面顺序读取持久 pageId；缺失或格式错误的页面返回 None。"""
    result = []
    for match in SECTION_OPEN_RE.finditer(s):
        found = PAGE_ID_RE.search(match.group(0))
        result.append(found.group(1) if found else None)
    return result

def ensure_page_ids(s, id_factory=None):
    """为缺失持久 ID 的页面补齐 UUID；已有合法 ID 原样保留。

    pageId 是页面身份，不包含页序、标题或 DOM 内容，因此改文案、模板升级和
    move_page 都不会改变它。重复或畸形 ID 直接拒绝，避免定位静默串页。
    """
    make_id = id_factory or (lambda: 'page-' + uuid.uuid4().hex)
    seen = set()

    def replace(match):
        tag = match.group(0)
        any_id = re.search(r'\bdata-page-id=(?:"[^"]*"|\'[^\']*\')', tag)
        if any_id:
            valid = PAGE_ID_RE.search(tag)
            if not valid:
                raise ValueError('data-page-id 格式无效，必须为 page- 加 32 位小写十六进制')
            value = valid.group(1)
        else:
            value = make_id()
            if not re.fullmatch(r'page-[0-9a-f]{32}', value):
                raise ValueError('id_factory 返回了无效 pageId')
            tag = tag[:-1] + f' data-page-id="{value}">'
        if value in seen:
            raise ValueError(f'data-page-id 重复：{value}')
        seen.add(value)
        return tag

    result = SECTION_OPEN_RE.sub(replace, s)
    if not seen:
        raise ValueError('未找到任何 section[data-label] 页面')
    return result


def _html_tag_end(source, start):
    """返回 quote-aware HTML start/end tag 的 ``>`` 位置；找不到则返回 -1。"""
    quote = None
    index = start + 1
    while index < len(source):
        char = source[index]
        if quote:
            if char == quote:
                quote = None
        elif char in ('"', "'"):
            quote = char
        elif char == '>':
            return index
        index += 1
    return -1


def _inject_editor_id(tag, value):
    body = tag[:-1]
    stripped = body.rstrip()
    whitespace = body[len(stripped):]
    if stripped.endswith('/'):
        return stripped[:-1] + f' data-editor-id="{value}" /' + whitespace + '>'
    return body + f' data-editor-id="{value}">'


def _remove_tag_attribute(tag, attribute_name):
    """从 start tag 中移除指定属性，不误伤其他属性的引号内文本。"""
    opening = re.match(r'<\s*[A-Za-z][\w:-]*', tag)
    if not opening:
        return tag
    cursor = opening.end()
    lowered_name = attribute_name.lower()
    while cursor < len(tag):
        whitespace_start = cursor
        while cursor < len(tag) and tag[cursor].isspace():
            cursor += 1
        if cursor >= len(tag) or tag[cursor] in ('>', '/'):
            return tag
        name_start = cursor
        while cursor < len(tag) and not tag[cursor].isspace() \
                and tag[cursor] not in ('=', '>', '/'):
            cursor += 1
        name = tag[name_start:cursor].lower()
        while cursor < len(tag) and tag[cursor].isspace():
            cursor += 1
        if cursor < len(tag) and tag[cursor] == '=':
            cursor += 1
            while cursor < len(tag) and tag[cursor].isspace():
                cursor += 1
            if cursor < len(tag) and tag[cursor] in ('"', "'"):
                quote = tag[cursor]
                cursor += 1
                while cursor < len(tag) and tag[cursor] != quote:
                    cursor += 1
                if cursor < len(tag):
                    cursor += 1
            else:
                while cursor < len(tag) and not tag[cursor].isspace() \
                        and tag[cursor] != '>':
                    cursor += 1
        if name == lowered_name:
            return tag[:whitespace_start] + tag[cursor:]
    return tag


def _transform_editor_ids(source, id_factory=None, create=False):
    """只扫描页面 section 的真实 start tag，并保持其他字节原样。

    不使用通用 HTML serializer：Deck 模板包含 raw-text script/style、内联 SVG 和
    对空白敏感的代码片段。这里的词法扫描只给可编辑后代 start tag 追加一个属性，
    不重排属性、不改变大小写，也不会把 script/style 内的 HTML 字符串当成节点。
    """
    make_id = id_factory or (lambda: 'element-' + uuid.uuid4().hex)
    output = []
    ids = []
    seen = set()
    cursor = 0
    page_section_depth = 0
    repeat_template_depth = 0
    raw_text_tag = None

    while cursor < len(source):
        if raw_text_tag:
            closing = re.search(
                rf'</\s*{re.escape(raw_text_tag)}\b', source[cursor:], re.IGNORECASE
            )
            if not closing:
                output.append(source[cursor:])
                cursor = len(source)
                break
            position = cursor + closing.start()
            output.append(source[cursor:position])
            cursor = position
            raw_text_tag = None

        position = source.find('<', cursor)
        if position < 0:
            output.append(source[cursor:])
            break
        output.append(source[cursor:position])

        if source.startswith('<!--', position):
            end = source.find('-->', position + 4)
            end = len(source) if end < 0 else end + 3
            output.append(source[position:end])
            cursor = end
            continue
        if source.startswith('<![CDATA[', position):
            end = source.find(']]>', position + 9)
            end = len(source) if end < 0 else end + 3
            output.append(source[position:end])
            cursor = end
            continue

        end = _html_tag_end(source, position)
        if end < 0:
            output.append(source[position:])
            break
        tag = source[position:end + 1]
        match = re.match(r'<\s*(/?)\s*([A-Za-z][\w:-]*)', tag)
        if not match:
            output.append(tag)
            cursor = end + 1
            continue
        closing = bool(match.group(1))
        name = match.group(2).lower()
        self_closing = bool(re.search(r'/\s*>$', tag))

        if closing:
            if name == 'sc-for' and repeat_template_depth:
                repeat_template_depth -= 1
            if name == 'section' and page_section_depth:
                page_section_depth -= 1
            output.append(tag)
            cursor = end + 1
            continue

        enters_page = name == 'section' and not page_section_depth \
            and bool(_PAGE_SECTION_ATTRIBUTE_RE.search(tag))
        inside_repeat_template = repeat_template_depth > 0
        editable = page_section_depth > 0 and name not in _EDITOR_ID_SKIP_TAGS \
            and name != 'section' and not inside_repeat_template
        if inside_repeat_template and _EDITOR_ID_ATTRIBUTE_RE.search(tag):
            # sc-for 的循环体是渲染模板：其中一个静态属性会被克隆到所有实例，
            # 因而绝不能作为持久元素身份。这里也迁移清理旧工作副本已注入的 ID。
            tag = _remove_tag_attribute(tag, 'data-editor-id')
        if editable:
            any_id = _EDITOR_ID_ATTRIBUTE_RE.search(tag)
            valid = EDITOR_ID_RE.search(tag)
            if any_id and not valid:
                raise ValueError(
                    'data-editor-id 格式无效，必须为 element- 加 32 位小写十六进制'
                )
            if valid:
                value = valid.group(1)
            elif create:
                value = make_id()
                if not re.fullmatch(r'element-[0-9a-f]{32}', value):
                    raise ValueError('id_factory 返回了无效 editorId')
                tag = _inject_editor_id(tag, value)
            else:
                value = None
            ids.append(value)
            if value is not None:
                if value in seen:
                    raise ValueError(f'data-editor-id 重复：{value}')
                seen.add(value)

        if name == 'section' and not self_closing:
            if enters_page:
                page_section_depth = 1
            elif page_section_depth:
                page_section_depth += 1
        if name == 'sc-for' and not self_closing:
            repeat_template_depth += 1
        if name in ('script', 'style') and not self_closing:
            raw_text_tag = name
        output.append(tag)
        cursor = end + 1

    return ''.join(output), ids


def editor_ids(s):
    """按页面 DOM 顺序读取可编辑元素身份；缺失身份返回 None。"""
    _, ids = _transform_editor_ids(s, create=False)
    return ids


def ensure_editor_ids(s, id_factory=None):
    """为页面内可编辑元素补齐持久身份，已有合法身份原样保留。"""
    result, _ = _transform_editor_ids(s, id_factory=id_factory, create=True)
    return result

def _fresh_page_id(block, existing_ids, id_factory=None):
    """插入页始终获得新身份；复制页面时不能沿用源页 pageId。"""
    make_id = id_factory or (lambda: 'page-' + uuid.uuid4().hex)
    matches = list(SECTION_OPEN_RE.finditer(block))
    if len(matches) != 1:
        raise ValueError('插入页块必须恰好包含一个 section[data-label]')
    value = make_id()
    while value in existing_ids:
        value = make_id()
    if not re.fullmatch(r'page-[0-9a-f]{32}', value):
        raise ValueError('id_factory 返回了无效 pageId')
    match = matches[0]
    tag = re.sub(r'\s+data-page-id=(?:"[^"]*"|\'[^\']*\')', '', match.group(0))
    tag = tag[:-1] + f' data-page-id="{value}">'
    return block[:match.start()] + tag + block[match.end():]

# ---------------- 增 / 删 / 移 页（自动同步三处）----------------
SEP = '\n\n    '

def insert_page(s, new_block, before_label, nav_code, nav_label, id_factory=None):
    """在 before_label 页之前插入 new_block。new_block 是完整 '<div class="slide-fit"...>...</div></div>'。
    自动：插 DOM、nav 在该页前插入并重编号、其后章节 start+1。
    章归属约定：插到某章首页之前 = 新页成为该章新首页（该章 start 不动）；
    插到章中/章尾页之前 = 新页属该章，下一章起各章 start+1。
    注意：必须在改动 DOM/nav 之前用 before 页的原索引定章——插入后 before 页索引 +1，
    若它原是章尾页，新索引会撞上下一章 start，导致下一章漏 +1。"""
    s = ensure_page_ids(s, id_factory=id_factory)
    new_block = _fresh_page_id(new_block, set(page_ids(s)), id_factory=id_factory)
    ns, ne, codes, lbls = _nav_entries(s)
    pos = lbls.index(before_label)
    starts = [int(m) for m in re.findall(r"start:(\d+)", s)]
    home = max([x for x in starts if x <= pos], default=0)  # before 页所属章（原索引）
    st, _ = _slide_bounds(s, before_label)
    assert s[st-len(SEP):st] == SEP
    s = s[:st-len(SEP)] + SEP + '    ' + new_block + s[st-len(SEP):]
    ns, ne, codes, lbls = _nav_entries(s)
    codes.insert(pos, nav_code); lbls.insert(pos, nav_label)
    s = _write_nav(s, codes, lbls)
    s = bump_chapters(s, +1, home)  # home 之后各章 +1
    return s

def delete_page(s, label):
    st, end = _slide_bounds(s, label)
    assert s[st-len(SEP):st] == SEP
    s = _bump_after_page(s, label, -1)
    s = s[:st-len(SEP)] + s[end:]
    ns, ne, codes, lbls = _nav_entries(s)
    pos = lbls.index(label); codes.pop(pos); lbls.pop(pos)
    s = _write_nav(s, codes, lbls)
    return s

def delete_page_by_id(s, page_id):
    """按稳定 data-page-id 删除页面；区域任务必须优先使用本函数。

    pageId 不随页序和标题变化，可避免重复 data-label 或 Agent 读取旧页序时删错页。
    实际三处同步仍复用 delete_page() 的同一实现。
    """
    if not re.fullmatch(r'page-[0-9a-f]{32}', page_id or ''):
        raise ValueError('page_id 必须为 page- 加 32 位小写十六进制')
    matches = [
        match for match in SECTION_OPEN_RE.finditer(s)
        if PAGE_ID_RE.search(match.group(0))
        and PAGE_ID_RE.search(match.group(0)).group(1) == page_id
    ]
    if len(matches) != 1:
        raise ValueError(f'page_id 必须唯一命中一页：{page_id}')
    label_match = re.search(r'\bdata-label="([^"]+)"', matches[0].group(0))
    if not label_match:
        raise ValueError(f'page_id 对应页面缺少 data-label：{page_id}')
    label = label_match.group(1)
    if sum(1 for match in SECTION_OPEN_RE.finditer(s)
           if re.search(r'\bdata-label="([^"]+)"', match.group(0)).group(1) == label) != 1:
        raise ValueError(f'data-label 重复，无法安全同步 nav：{label}')
    return delete_page(s, label)

def move_page(s, label, after_label):
    """把 label 页移到 after_label 页之后（同章内移动：章节 start 不变；只动 DOM + nav 顺序）。"""
    st, end = _slide_bounds(s, label)
    chunk = SEP + s[st:end]           # 含前置分隔符
    assert s[st-len(SEP):st] == SEP
    s = s[:st-len(SEP)] + s[end:]     # 先移除
    _, dst_end = _slide_bounds(s, after_label)
    s = s[:dst_end] + chunk + s[dst_end:]
    ns, ne, codes, lbls = _nav_entries(s)
    i = lbls.index(label); c, l = codes.pop(i), lbls.pop(i)
    j = lbls.index(after_label)
    codes.insert(j+1, c); lbls.insert(j+1, l)
    s = _write_nav(s, codes, lbls)
    return s

def _bump_after_page(s, ref_label, delta):
    """ref 页所在章之后的所有章 start ±delta（增删页时用）。靠 nav 位置定位章。"""
    # 计算 ref 页的 DOM 序号（= nav 索引），再找它落在哪个 chapter 区间，其后各章 start 调整
    _, _, codes, lbls = _nav_entries(s)
    # 重新解析当前 nav 顺序对 DOM 顺序：nav 已与 DOM 同步，ref_label 的 nav index 即 DOM index
    try:
        idx = lbls.index(ref_label)
    except ValueError:
        return s
    starts = [int(m) for m in re.findall(r"start:(\d+)", s)]
    # 该页所属章 = 最大的 start <= idx
    home = max([x for x in starts if x <= idx], default=0)
    return bump_chapters(s, delta, home)

# ---------------- 矩阵网格助手 ----------------
def grid(rows, red=None, cell=30, fs=15):
    red = red or set(); h = '<table style="border-collapse:collapse;border:1.5px solid #b0b0b6;">'
    for ri, row in enumerate(rows):
        h += '<tr>'
        for ci, v in enumerate(row):
            isr = (ri, ci) in red; col = '#d4001a' if isr else '#1a1a1c'; wt = '700' if isr else '400'
            h += ('<td style="width:%dpx;height:%dpx;border:1px solid #cfcfd4;text-align:center;'
                  'font-family:JetBrains Mono,monospace;font-size:%dpx;color:%s;font-weight:%s;padding:0;">%s</td>'
                  % (cell, cell, fs, col, wt, v))
        h += '</tr>'
    return h + '</table>'

# ---------------- 验证 ----------------
def _verify_lines(lines, verbose=False):
    s = get_template(lines)
    nslide = s.count('class="slide-fit"')
    nsec = s.count('<section data-label=')
    nums = [int(x) for x in re.findall(r'\{ i:(\d+),', s)]
    ids = page_ids(s)
    ok_seq = nums == list(range(len(nums)))
    if verbose:
        print('slide-fit=%d  sections=%d  nav=%d  nav_seq_ok=%s' % (nslide, nsec, len(nums), ok_seq))
        print('page_ids=%d  page_ids_unique=%s' % (
            len([value for value in ids if value]),
            len(ids) == len(set(ids)) and all(ids),
        ))
        print('chapters:', re.findall(r"name:'[^']+', start:\d+", s))
    assert nslide == nsec == len(nums), 'slide / section / nav 三处同步失败'
    assert ok_seq, 'nav i: not sequential — 三处同步没做全'
    if any(ids):
        assert len(ids) == nsec and all(ids), 'data-page-id 必须覆盖全部页面'
        assert len(set(ids)) == len(ids), 'data-page-id 必须全局唯一'
    return True

def verify(path):
    return _verify_lines(load(path), verbose=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='安全编辑或验证 AICO-PPT bundle')
    parser.add_argument('deck', nargs='?')
    parser.add_argument('--ensure-page-ids', action='store_true', help='补齐持久 pageId 后写回')
    args = parser.parse_args()
    if not args.deck:
        print(__doc__)
    elif args.ensure_page_ids:
        bundle = load(args.deck)
        set_template(bundle, ensure_page_ids(get_template(bundle)))
        save(args.deck, bundle)
        verify(args.deck)
    else:
        verify(args.deck)
