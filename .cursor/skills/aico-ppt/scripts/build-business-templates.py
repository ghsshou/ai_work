#!/usr/bin/env python3
"""重建通用任职与项目评审模板；内容、图形、目录均为可编辑占位。"""
from pathlib import Path
import importlib.util
import html
import json
import re
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parent.parent

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    obj = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(obj)
    return obj

eb = module('eb_business', ROOT / 'scripts/edit-bundle.py')
up = module('up_business', ROOT / 'scripts/upgrade_deck.py')
H = html.escape

def p(text):
    return '<p>'+H(text)+'</p>'

def box(title, content='', cls=''):
    return f'<div class="bt-box {cls}"><h4>{H(title)}</h4>{content}</div>'

def grid(*children, cols=2, cls=''):
    return f'<div class="bt-grid {cls}" style="grid-template-columns:repeat({cols},minmax(0,1fr));">'+''.join(children)+'</div>'

def placeholder(title, hint='替换为当前材料的证据，注明来源与口径'):
    return f'<div class="bt-placeholder"><b>{H(title)}</b><span>{H(hint)}</span></div>'

def fields(*items):
    return ''.join(f'<div class="bt-field"><b>{H(item)}</b><span>［待填写］</span></div>' for item in items)

def table(headers, rows, compact=False):
    if isinstance(headers,str): headers=headers.split('|')
    if isinstance(rows,str): rows=[[x]+['［待填写］']*(len(headers)-1) for x in rows.split('|')]
    size=19 if compact else 23
    out=f'<table class="bt-table" style="font-size:{size}px;"><thead><tr>'+''.join('<th>'+H(x)+'</th>' for x in headers)+'</tr></thead><tbody>'
    for row in rows:
        out+='<tr>'+''.join('<td>'+H(str(x))+'</td>' for x in row)+'</tr>'
    return out+'</tbody></table>'

def chain(labels, subtitle='每个环节填写输入、责任动作与输出'):
    return '<div class="bt-chain">'+''.join(f'<div><b>{i+1:02}</b><strong>{H(x)}</strong><span>［关键动作］</span><span>［交付物 / 证据］</span></div>' for i,x in enumerate(labels))+'</div>'+p(subtitle)

# 原生 SVG 仅承载可编辑的组织、网络、接口及机房工程图。
def svg_start(w=1200,h=700):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" style="width:100%;height:100%;min-height:0;" role="img"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="#687785"/></marker></defs>'

def node(x,y,w,h,label,fill='#f7f8fa',color='#25313a'):
    labels=label.split('|');out=f'<g><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="5" fill="{fill}" stroke="#8895a1" stroke-width="1.5"/>'
    for i,t in enumerate(labels):out+=f'<text x="{x+w/2}" y="{y+h/2+(i-(len(labels)-1)/2)*27+8}" text-anchor="middle" fill="{color}" font-size="22" font-family="Noto Sans SC,sans-serif">{H(t)}</text>'
    return out+'</g>'

def line(x1,y1,x2,y2,color='#687785',arrow=False):
    return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="2"'+(' marker-end="url(#arrow)"' if arrow else '')+'/>'

def label(x,y,text,color='#525b64',size=22):
    return f'<text x="{x}" y="{y}" fill="{color}" font-size="{size}" font-family="Noto Sans SC,sans-serif">{H(text)}</text>'

def org(delivery=False):
    s=svg_start()
    root='项目决策委员会|［负责人］' if delivery else '客户决策层|［姓名 / 职务］'
    s+=node(415,20,370,85,root,'#e7edf5')
    for i,t in enumerate(['项目管理','技术管理','业务与运营']):
        x=35+i*405;s+=line(600,105,x+175,205);s+=node(x,205,350,90,t+'|［对口人］')
        for j,sub in enumerate([['进度 / 资源','供应 / 采购'],['方案 / 集成','网络 / 安全'],['业务 / 测试','验收 / 运维']][i]):
            xx=x+j*180;s+=line(x+175,295,xx+80,435);s+=node(xx,435,165,90,sub+'|［责任人］')
    return s+label(35,630,'实线表示汇报或执行关系；跨组织接口在右侧说明')+'</svg>'

def architecture():
    rows=[('应用与业务',['业务场景 A','业务场景 B','模型与应用']),('平台与调度',['任务调度','资源管理','业务接口']),('系统与软件',['操作系统','计算软件栈','集群管理']),('计算与网络',['计算节点','业务与管理网络','存储系统']),('机房与配套',['供配电','制冷与液冷','机柜与布线'])]
    s=svg_start()
    for i,(name,parts) in enumerate(rows):
        y=15+i*132;s+=node(5,y,205,110,name,'#4d729f','#fff')
        for j,t in enumerate(parts):s+=node(235+j*255,y,235,110,t+'|［产品 / 版本］')
    s+=node(1010,15,180,638,'运维控制面|监控与告警|账号与权限|配置与变更|［责任主体］','#edf2f7')
    return s+'</svg>'

def network(kind='overall'):
    s=svg_start();business=kind!='management'
    if kind=='overall':
        for x,t in [(20,'业务 / 模型'),(820,'存储与外部系统')]:s+=node(x,15,350,78,t)
        s+=node(420,15,350,78,'外部接入 / 专线|［带宽与边界］')
        for x in [210,750]:s+=line(595,93,x+120,180);s+=node(x,180,260,76,'核心 / 汇聚|［规格］','#e7edf5')
        for i in range(4):
            x=20+i*300
            for xx in [340,880]:s+=line(xx,256,x+130,360)
            s+=node(x,360,260,76,'接入交换机 '+chr(65+i)+'|［端口 / 冗余］')
            s+=line(x+130,436,x+130,540);s+=node(x,540,260,90,['计算节点组 A','计算节点组 B','管理与部署节点','存储节点'][i]+'|［数量］')
        s+=label(20,680,'链路标注：［速率］、［介质］、［数量］；实线示意逻辑连接')
    else:
        levels=['互联层','核心层','汇聚层','接入层'] if business else ['管理核心','管理汇聚','带内接入','带外接入']
        for level,name in enumerate(levels):
            y=20+level*142
            for j in range(3):
                x=200+j*330
                if level:
                    for k in range(3):s+=line(320+k*330,y-65,x+115,y)
                s+=node(x,y,230,77,name+' '+chr(65+j)+'|［型号 / 端口］','#e7edf5' if level==0 else '#fff')
            s+=label(5,y+45,['S3 / 边界','S2 / 汇聚','S1 / 接入','S0 / 节点'][level] if business else levels[level])
        s+=label(200,658,'下联计算节点 / 管理口：［数量、速率与布线责任］')
    return s+'</svg>'

def floorplan():
    s=svg_start();s+='<rect x="25" y="30" width="815" height="590" fill="#fff" stroke="#697582" stroke-width="3"/>'
    for r in range(3):
        for c in range(7):s+=node(60+c*107,80+r*180,90,100,chr(65+r)+f'{c+1:02}','#e8eef5' if r!=1 else '#f1e7e8')
        if r<2:s+=label(75,220+r*180,'通道：［净宽］ / ［冷通道或热通道］',size=21)
    s+=label(45,660,'平面示意：编号、数量和尺寸按现场工勘重绘')
    s+=node(890,60,280,130,'供配电 / 列头柜|［容量与位置］')+node(890,235,280,130,'液冷 / 风冷配套|［能力与接口］')+node(890,410,280,130,'门 / 消防 / 承重|［现场限制］')
    return s+'</svg>'

def timeline():
    stages=['条件确认','物料齐套','安装布线','调测验证','验收移交'];lanes=['机房工程','网络与专线','算力集群','业务与运维']
    s=svg_start()
    for j,t in enumerate(stages):s+=label(190+j*202,32,t,size=23)
    for i,t in enumerate(lanes):
        y=125+i*145;s+=label(5,y+20,t);s+=line(180,y,1180,y,'#c3cbd1')
        for j in range(5):
            x=192+j*202;s+=f'<circle cx="{x}" cy="{y}" r="7" fill="#b5333b"/>';s+=label(x-10,y-26,'［日期］',size=19);s+=node(x-5,y+30,177,65,['输入条件','工作包','责任人','输出证据','签署材料'][j]+'|［待填写］')
    return s+'</svg>'

def lifecycle():
    return '<div class="bt-grow">'+chain(['准备与设计','集成与调测','验证与验收','运行与改进'])+'</div>'+grid(box('各阶段责任',fields('主责人','协作方','交接接口')),box('各阶段证据',fields('输入条件','交付物','验收标准')))

CSS='''
.bt-grid:has(> .bt-grow > svg){grid-template-columns:minmax(0,2.2fr) minmax(0,1fr)!important}
.bt-qualification .layerbtn[data-active]{color:#a22d35!important}
section.bt-qualification-cover{background-image:none!important}
.bt-slide{width:100%;height:100%;padding:48px 68px 75px;display:flex;flex-direction:column;position:relative;overflow:hidden;background:#fff;font-family:'Noto Sans SC',sans-serif;color:#23282d;box-sizing:border-box}
.bt-slide.bt-qualification{background:#edeef1;--bt-accent:#4d729f}
.bt-slide{--bt-accent:#b40000}.bt-slide h3{font-size:44px;line-height:1.2;color:#a22d35;margin:0 0 18px;font-weight:700;padding-bottom:14px;border-bottom:3px solid #b5333b}.bt-body{flex:1;min-height:0;display:flex;flex-direction:column;gap:20px}.bt-body h4{font-size:28px;line-height:1.3;margin:0 0 14px;color:#84313a}.bt-body p{font-size:24px;line-height:1.5;margin:10px 0}.bt-grid{display:grid;gap:20px;min-height:0;flex:1}.bt-box{min-width:0;min-height:0;background:#fff;border:1px solid #cfd2d8;border-radius:14px;padding:22px;display:flex;flex-direction:column;box-sizing:border-box}.bt-field{display:flex;gap:18px;justify-content:space-between;align-items:center;min-height:48px;border-bottom:1px solid #e0e3e7;font-size:23px;line-height:1.5}.bt-field b{font-weight:600}.bt-field span{color:#747c85;white-space:nowrap}.bt-placeholder{border:1.5px dashed #9ba6b1;background:#f5f7f9;min-height:120px;flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:15px;padding:20px;box-sizing:border-box;font-size:25px;color:#626d79}.bt-placeholder span{font-size:20px}.bt-table{border-collapse:collapse;table-layout:fixed;width:100%;height:100%;line-height:1.35}.bt-table th{background:var(--bt-accent);color:white;padding:10px;border:1px solid #b6bdc6;font-weight:600;text-align:left}.bt-table td{border:1px solid #aeb7c0;padding:10px;vertical-align:middle;overflow-wrap:anywhere}.bt-table td:first-child{background:#f0f3f6}.bt-chain{display:flex;gap:16px;flex:1;min-height:0}.bt-chain>div{flex:1;min-width:0;border:1px solid #cfd5dc;background:white;padding:22px;display:flex;flex-direction:column;justify-content:center;gap:25px}.bt-chain b{font-size:34px;color:#b5333b}.bt-chain strong{font-size:28px}.bt-chain span{font-size:22px;color:#707983}.bt-grow{flex:1;min-height:0;display:flex;flex-direction:column}.bt-note{font-size:21px!important;color:#6c737a}.bt-hero{font-size:43px!important;line-height:1.6!important}.bt-toc .layerpanel{height:100%}.bt-toc .layerpanel p{font-size:25px}.bt-subhead{font-size:25px;padding:14px;background:#e3eaf3;color:#324c70}.bt-section{justify-content:center;padding:90px 130px}.bt-section h3{font-size:66px}.bt-section p{font-size:32px;line-height:1.8}.bt-toc h4{font-size:34px;color:#a22d35;margin:0 0 28px}.bt-toc p{font-size:26px;line-height:1.65}
'''

class Deck:
    def __init__(self,kind,chapters):
        self.kind=kind;self.chapters=chapters;self.pages=[]
        self.lines=eb.load(ROOT/'assets/work-report-deck.html');self.s=up.canonicalize_metadata(eb.get_template(self.lines))
        for name in re.findall(r'<section data-label="([^"]+)"',self.s):
            if name not in ['封面','目录','结语页']:
                self.separator(name);self.s=eb.delete_page(self.s,name)
        self.s=up.patch_bundle.strip_block(self.s)
        self.s=up._replace_slot(self.s,up.USER_STYLE_START,up.USER_STYLE_END,'\n<style>\n'+CSS+'</style>\n')
        self.s=up._replace_slot(self.s,up.USER_SCRIPT_START,up.USER_SCRIPT_END,'\n')
        self.s=re.sub(r'<title>.*?</title>',f'<title>{"任职材料" if kind=="qualification" else "项目评审"}通用模板</title>',self.s,count=1,flags=re.S)
        self.s=self.s.replace('>工作汇报模板</button>',f'>{"任职材料" if kind=="qualification" else "项目评审"}通用模板</button>')
    def separator(self,label):
        start,_=eb._slide_bounds(self.s,label)
        if self.s[start-len(eb.SEP):start]!=eb.SEP:self.s=self.s[:start]+eb.SEP+self.s[start:]
    def add(self,pid,title,family,chapter,content,source=None):
        block=f'<div class="slide-fit" data-idx="0"><div class="slide-canvas"><section data-label="{title}" class="bt-slide bt-{self.kind}" data-layout-family="{family}"><h3>{title}</h3><div class="bt-body">{content}</div></section></div></div>'
        self.separator('结语页');self.s=eb.insert_page(self.s,block,'结语页',title,title)
        self.pages.append(dict(pageTypeId=pid,name=title,sourcePage=len(self.pages)+3,visualFamily=family,density='dense' if family in ['matrix','diagram','evidence'] else 'medium',chapter=chapter,referencePage=source))
    def replace_cover(self,section):
        a,b=eb._slide_bounds(self.s,'封面');self.s=self.s[:a]+'<div class="slide-fit" data-idx="0"><div class="slide-canvas">'+section+'</div></div>'+self.s[b:]
    def finish(self):
        a,b=eb._slide_bounds(self.s,'目录');old=self.s[a:b];opening=re.search(r'<section\b[^>]*>',old).group();opening=opening.replace('style="','class="bt-toc" style="',1)
        buttons=[];panels=[];builders=[]
        for i,c in enumerate(self.chapters):
            active=' data-active=""' if i==0 else '';step='' if i==0 else f' data-step="{i-1}"';cid=f'{self.kind}-{i+1}';key=f'chapter-{i+1:02d}'
            buttons.append(f'<button class="layerbtn toc-layer-btn" data-layer-btn="{key}" data-layer-group="toc" data-toc-chapter-id="{cid}"{active}{step} style="background:white;text-align:left;border:0;border-bottom:1px solid #ddd;padding:13px 18px;font-size:27px;"><span class="toc-layer-name">{c}</span></button>')
            panels.append(f'<div class="layerpanel" data-layer-panel="{key}" data-layer-group="toc" data-toc-chapter-id="{cid}" data-toc-title="{c}"{active}><h4>{c}</h4><div data-toc-visual-index="{i}" data-toc-chapter-id="{cid}" data-toc-animation-topic="{c}"></div></div>')
            topics=[x['name'] for x in self.pages if x['chapter']==i and x['visualFamily']!='transition']
            body=''.join(p(x) for x in topics[:8]);builders.append(f'function businessToc{i}(){{return {json.dumps(body,ensure_ascii=False)};}}')
        toc='<div class="slide-fit" data-idx="1"><div class="slide-canvas">'+opening+'<h3 style="margin:0 0 30px;font-size:60px;">目录</h3><div style="flex:1;min-height:0;display:flex;gap:30px;"><div id="tocVisual" style="flex:1;padding:35px;border:1px solid #ddd;border-radius:18px;">'+''.join(panels)+'</div><div style="flex:1;display:flex;flex-direction:column;justify-content:center;">'+''.join(buttons)+'</div></div></section></div></div>'
        self.s=self.s[:a]+toc+self.s[b:]
        self.s=re.sub(r'const tocBuilders = \[[^\]]*\];','\n'.join(builders)+'\nconst tocBuilders = ['+', '.join(f'businessToc{i}' for i in range(len(self.chapters)))+'];',self.s,count=1)
        chapters=["      { name:'%s', start:%d },"%(c,2+next(i for i,x in enumerate(self.pages) if x['chapter']==j)) for j,c in enumerate(self.chapters)]
        self.s=re.sub(r'const chapters = \[.*?\];','const chapters = [\n'+'\n'.join(chapters)+'\n    ];',self.s,count=1,flags=re.S)
        idx=iter(range(len(self.pages)+3));self.s=re.sub(r'(<div class="slide-fit" data-idx=")\d+("[^>]*>)',lambda m:m[1]+str(next(idx))+m[2],self.s)
        self.s=up.set_template_kind(up.set_version(self.s,up.CURRENT_VERSION),self.kind)
        self.s=eb.ensure_page_ids(self.s)
        self.s=up.set_runtime_hash(self.s,up.runtime_hash(self.s))
        # 仅保留当前模板及其运行时引用的资源，避免携带参考案例图片或附件。
        manifest=eb.get_manifest(self.lines);manifest={k:v for k,v in manifest.items() if k in self.s}
        eb.set_manifest(self.lines,manifest);eb.set_template(self.lines,self.s)
        path=ROOT/'assets'/f'{self.kind}-deck.html';eb.save(path,self.lines);eb.verify(path)
        return path

def qualification():
    d=Deck('qualification',['工作经历与项目','专业能力与贡献','业务思考与改进'])
    d.replace_cover('''<section data-label="封面" class="bt-qualification-cover" style="width:100%;height:100%;position:relative;overflow:hidden;background:white;font-family:'Noto Sans SC',sans-serif;"><div style="position:absolute;top:190px;left:0;width:1230px;height:560px;background:#8f9194;clip-path:polygon(0 0,100% 0,86% 100%,0 100%);"></div><div style="position:absolute;top:180px;right:0;width:540px;height:590px;background:#8f2027;border-radius:50% 0 0 50%/58% 0 0 42%;"></div><div style="position:absolute;top:255px;left:70px;width:990px;color:white;"><h2 style="font-size:58px;line-height:1.3;margin:0;">任职资格评审材料</h2><p style="margin-top:24px;font-size:34px;">［专业类别］ · ［申请岗位 / 级别］</p></div><div style="position:absolute;top:550px;left:70px;color:white;font-size:29px;line-height:1.9;">部门：［部门名称］<br/>申请人：［姓名 / 工号］<br/>评审日期：［日期］</div></section>''')
    add=d.add
    add('experience-table','工作经历','matrix',0,'<div style="flex:1;min-height:0;">'+table('基本信息|待填写内容|任职信息|待填写内容',[
        ['姓名 / 工号','［待填写］','申请专业 / 级别','［待填写］'],['部门 / 岗位','［待填写］','当前任职资格','［待填写］'],['绩效周期及结果','［按实际记录填写］','业务领域与主技能','［待填写］']])+'</div><div style="flex:2;min-height:0;">'+table('时间|组织 / 岗位|职责范围|关键工作与结果','任职阶段一|任职阶段二|任职阶段三')+'</div>',3)
    add('project-portfolio','主要项目','matrix',0,table('项目 / 级别|周期|本人角色|难点与贡献|结果与证明材料','代表项目一|代表项目二|代表项目三|代表项目四'),4)
    add('evaluation-divider','专业能力自评','transition',1,p('本章围绕任职标准，组织知识、能力与贡献证据。')+chain(['专业知识','关键能力','专业回馈']),5)
    add('skill-assessment','专业知识与技能','evidence',1,'<div style="flex:1;min-height:0;display:flex;gap:20px;">'+''.join(placeholder(t,'仅放入本人有效材料') for t in ['证书或资质','专业实践证明','评估记录'])+'</div><div style="flex:1;min-height:0;">'+table('技能领域|自评等级|应用岗位 / 场景|对应证据','核心技能|关联技能|融合技能')+'</div>',6)
    add('knowledge-themes','专业知识主题','sequence',1,grid(box('主题一：［核心专业方向］',chain(['知识框架','关键方法','项目应用','结果验证'])),box('主题二：［关联专业方向］',chain(['能力缺口','学习与实践','方法沉淀','组织复用'])),cols=1),7)
    add('delivery-model','职责与协同交付模式','diagram',1,'<div class="bt-grow">'+chain(['现场交付角色','协同管理角色','远程专家角色'])+'</div>'+grid(box('本人职责边界',fields('决策职责','执行职责','升级与交接条件')),box('协同平台与机制',fields('信息输入','工作流与工具','结果及证据回传'))),8)
    add('solution-architecture','技术方案与架构设计','diagram',1,grid('<div class="bt-grow">'+architecture()+'</div>',box('架构设计举证',fields('业务目标','关键技术约束','本人负责模块','方案取舍','验证结果','设计文档')),cols=2),9)
    add('technical-leadership','技术领导力与工程挑战','matrix',1,grid('<div class="bt-grow">'+table('关键挑战|本人技术判断|组织与执行动作|验证证据','需求与架构|工程质量|跨团队协同|交付节奏|风险与变更')+'</div>',box('交付结果与组织贡献',fields('成果指标及口径','可复用资产','团队能力变化','证明材料'))),10)
    add('issue-reconstruction','复杂问题处理与工程实现','evidence',1,grid(box('输入与约束',placeholder('问题现场 / 输入材料')+fields('问题现象','数据限制')),box('定位与实现过程',chain(['信息整理','关键判断','方案实现'])+p('［填写本人采用的方法与取舍依据］')),box('输出与验证',placeholder('输出结果 / 验证证据')+fields('验证标准','应用效果')),cols=3),11)
    add('issue-root-cause','问题定位与根因闭环','evidence',1,grid(box('01 问题现象',p('［填写影响范围、触发条件与失败表现］')+placeholder('关键日志 / 现场截图')),box('02 定位路径',chain(['收集证据','验证假设','缩小范围'])),box('03 根因机制',placeholder('机制图 / 数据流 / 调用链','用可编辑图解释触发条件与因果关系')),box('04 修复与验证',fields('本人修复动作','回归范围','验证结果','防复发措施')),cols=2),12)
    add('performance-evidence','性能优化与对比证据','comparison',1,grid(box('基线与优化方案',table('对比维度|基线|优化后','测试环境|数据与负载|关键参数|性能指标|资源使用')),box('过程证据',placeholder('填入测量曲线或性能分析图','注明坐标、单位、基线和样本范围')+fields('主要瓶颈','证据支持的结论'))),13)
    add('solution-resource-plan','方案论证与资源规划','diagram',1,grid(box('系统结构与关键差异','<div class="bt-grow">'+architecture()+'</div>'),box('实验设计与资源约束',fields('技术假设','验证任务','资源与拓扑','对照基线','可行性结论')+placeholder('实验结果或资源规划图'))),14)
    add('customer-alignment','客户沟通与跨团队对齐','grid',1,grid(*[box('场景 '+x+'：［沟通主题］',fields('客户问题或诉求','本人判断与沟通动作','协同对象与承诺','结果及证明材料')) for x in ['一','二','三','四']]),15)
    add('project-retrospective','项目复盘与可重复方法','comparison',1,grid(*[box('项目 '+x+'：［名称］',fields('项目背景与约束','关键技术判断','本人动作与结果','可重复方法','适用范围与边界')+placeholder('方法或资产示例')) for x in ['一','二']]),16)
    buttons=[];panels=[]
    for i,t in enumerate(['业务与需求','方案与架构','工具与实现','验证与质量','交付与协同','知识与复用']):
        active=' data-active=""' if i==0 else '';step='' if i==0 else f' data-step="{i-1}"'
        buttons.append(f'<button class="layerbtn" data-layer-btn="skill-{i}" data-layer-group="qualification-skills"{active}{step} style="font-size:24px;padding:17px;text-align:left;border:1px solid #ccd2da;background:#fff;">{t}</button>')
        panels.append(f'<div class="layerpanel" data-layer-panel="skill-{i}" data-layer-group="qualification-skills"{active}><h4>{t}</h4>'+fields('目标学员或对象','知识与技能目标','课程与实践设计','实践验证方式','资产及应用效果')+'</div>')
    add('training-curriculum','训战体系与能力传递','interactive',1,grid('<div style="display:flex;flex-direction:column;gap:16px;">'+''.join(buttons)+'</div>',box('能力模块与训练结果',''.join(panels)),box('实践路径',chain(['任务准备','实践演练','结果评估'])+placeholder('课程资产 / 实验示例')),cols=3),17)
    add('professional-giveback','专业回馈与知识资产','matrix',1,table('贡献类别|具体资产|本人贡献|使用效果与范围|证明材料','案例与经验总结|实践指南|课程与培训|工具与方法|标准与专业活动'),18)
    add('reflection-divider','业务思考与能力改进','transition',2,p('基于实际项目形成业务判断，并明确个人能力改进方向。')+chain(['项目观察','业务判断','改进行动']),19)
    add('business-reflection','业务思考与专业判断','matrix',2,grid('<div class="bt-grow">'+table('项目观察|技术与业务变化|风险或能力边界|本人判断','观察一|观察二|观察三')+'</div>',box('对业务与能力建设的建议',fields('目标业务对象','建议与事实依据','实施条件','预期产物与验证'))),20)
    add('improvement-plan','个人能力改进计划','sequence',2,grid(*[box(t,fields('当前差距与事实','具体行动','阶段目标','验证方式')) for t in ['专业深度','沟通与协同','技术领导力','业务理解']]),21)
    d.finish();return d

DRB_SOURCE=ROOT/'assets/project-review-refs/DRB-AI算力平台项目-V5.3.pptx'
NS={'a':'http://schemas.openxmlformats.org/drawingml/2006/main'}

def source_table(number,index=0,max_rows=8):
    """保留参考表格的字段与分类，去除项目值；模板行可按实际任务扩展。"""
    with zipfile.ZipFile(DRB_SOURCE) as z:
        root=ET.fromstring(z.read(f'ppt/slides/slide{number}.xml'))
    tables=root.findall('.//a:tbl',NS)
    if index>=len(tables):return table('事项|范围|责任人|依据','事项一|事项二|事项三')
    data=[]
    for tr in tables[index].findall('a:tr',NS):
        data.append([''.join(x.text or '' for x in tc.findall('.//a:t',NS)).strip() for tc in tr.findall('a:tc',NS)])
    headers=data[0];headers=[('周期 '+str(i+1)) if re.search(r'\d+[年月]',x) else x or '字段 '+str(i+1) for i,x in enumerate(headers)]
    rows=[]
    for i,row in enumerate(data[1:max_rows+1]):
        out=[]
        for j,v in enumerate(row):
            keep=(j==0 or (j==1 and row[0].strip().isdigit())) and len(v)<32
            out.append(v if keep and v else '［待填写］')
        rows.append(out)
    return table(headers,rows,compact=len(headers)>5 or len(rows)>6)

def project_review():
    chapters=['项目背景及概况','标书与合同分析','解决方案可交付性评审','项目交付方案','分包与伙伴能力评估','项目假设','项目交付风险','运营运维方案','项目服务成本测算','项目DRB决策点']
    d=Deck('project-review',chapters)
    d.s=d.s.replace('汇报主标题（占位）：把本期最大的结论写成一句','［项目名称］<br/>项目评审点决策（DRB）').replace('副标题 · 汇报周期与范围（如 2026 Q2 · X 项目）','［本次评审范围］ · ［交付场景］').replace('部门：主讲团队 / 单位名（占位）','部门 / 代表处：［待填写］').replace('汇报人：（占位）','项目经理 / 工号：［待填写］').replace('日期：2026-XX-XX','日期：［待填写］')
    def add(n,pid,title,family,body):
        ch=next((i for i,start in reversed(list(enumerate([2,9,17,29,42,44,46,48,51]))) if n>=start),0)
        d.add(pid,title,family,ch,body,n)
    add(2,'review-entry','DRB评审要求','statement',grid(box('入口条件与时间点',fields('本次评审入口条件','前置决策与依赖','计划上会时间','材料提交节点')),box('申请与组织安排',fields('评审组织与联系人','申请入口','适用操作指导','所需输入件')))+p('按当前项目组织的最新要求填写；未满足的入口条件须明确补齐计划。'))
    add(3,'decision-inputs','DRB决策输入件','matrix',source_table(3,max_rows=9))
    add(5,'project-profile','项目背景及概况','matrix',table('信息项|本次评审范围|信息项|本次评审范围',[
        ['项目名称 / 编码','［待填写］','项目经理 / 角色','［待填写］'],['客户 / 签约模式','［待填写］','交付场景','［待填写］'],['设备与服务规模','［待填写］','项目阶段','［待填写］'],['最终客户与使用方','［待填写］','交付环境','［待填写］'],['本次交付范围','［待填写］','范围外与后续扩容','［待填写］'],['业务目标','［待填写］','工期及起算条件','［待填写］'],['商业模式','［待填写］','关键依据','［待填写］']]))
    add(6,'customer-value','客户价值与主张','statement',box('客户业务目标',p('［说明客户当前业务问题、建设目标和预期收益］'))+grid(box('当前问题',fields('问题表现','影响范围','证据与基线')),box('本次项目价值',fields('目标业务对象','建设能力','效果验证方式')),box('范围与约束',fields('适用业务场景','不承诺的范围','关键前置条件')),cols=3))
    add(7,'customer-organization','客户组织架构与沟通矩阵','diagram',grid('<div class="bt-grow">'+org()+'</div>',box('关键干系人与沟通接口',fields('项目决策人','技术与业务负责人','验收与运维接口','沟通频率','决策与纪要机制'))))
    add(8,'delivery-organization','交付组织架构与沟通机制','diagram',grid('<div class="bt-grow">'+org(True)+'</div>',box('责任人与例行机制',fields('项目经理 / 技术总监','专业负责人','供应链与采购','项目例会','客户分层沟通','问题升级机制'))))
    add(9,'contract-divider','章节·标书与合同分析','transition',chain(['交易与场景','范围与配置','责任与条款']))
    s=svg_start(1000,700)
    for i,t in enumerate(['最终客户','总集成商 / 渠道','签约主体','供货与服务主体']):
        y=20+i*173;s+=node(310,y,420,90,t+'|［组织名称］','#f0f3f6')
        if i<3:s+=line(445,y+90,445,y+170,'#4b729f',True)+line(600,y+170,600,y+90,'#b5333b',True)
    s+=label(50,260,'合同 / 交付流','#4b729f')+label(770,435,'回款 / 验收流','#b5333b')+'</svg>'
    add(10,'transaction-flow','交易模式与合同界面','sequence',grid('<div class="bt-grow">'+s+'</div>',box('各环节需明确',fields('签约路径','签约业务范围','付款与回款条件','交付与验收主体','跨合同边界'))))
    add(11,'project-scenario','项目场景与系统范围','diagram',grid('<div class="bt-grow">'+architecture()+'</div>',box('范围图例与说明',fields('本方供货范围','第三方供货范围','客户自建范围','本次交付边界','产品与版本依据'))))
    add(12,'service-scope','项目范围·服务','matrix',table('服务项目|服务内容与边界|数量与周期|验收方式','集群集成交付|平台部署与调测|运维平台部署|驻场服务|维保与备件|配套服务'))
    add(13,'equipment-scope','项目范围·本期设备','matrix',table('设备类别|型号与版本|数量 / 单位|规格及配置|范围依据','计算设备|网络设备|存储设备|光模块|互联线缆|机房配套'))
    add(14,'expansion-scope','项目范围·扩容与分期','matrix',table('设备或服务|本期规模|后续批次|扩容条件|本次评审是否承接','计算节点|网络与互联|存储能力|供配电及制冷|交付服务|运维服务'))
    add(15,'responsibility-matrix','责任矩阵','matrix',table('交付任务|客户|总集成商|设备方|服务方|边界与争议','机房准备|设备上架|布线与端接|网络配置|软件部署|系统联调|测试与验收|运行维护',compact=True))
    add(16,'contract-terms','其他关键条款分析','matrix',source_table(16,max_rows=8))
    add(17,'solution-divider','章节·解决方案可交付性评审','transition',chain(['系统与组网','现场与集成','结论与闭环']))
    add(18,'solution-architecture','智算集群整体技术架构','diagram',grid('<div class="bt-grow">'+architecture()+'</div>',box('架构评审关注项',fields('组件与产品版本','跨层接口','成熟度与验证状态','功能及性能边界','集成责任主体'))))
    add(19,'deliverability-conclusion','解决方案可交付性评审结论','matrix',fields('DTRB评审结论','结论及审批证据')+source_table(19,max_rows=6))
    add(20,'network-overview','项目整体组网拓扑','diagram',grid('<div class="bt-grow">'+network()+'</div>',box('总体组网说明',fields('计算与存储边界','外部接入与专线','业务 / 管理平面','冗余与隔离','各平面主责方'))))
    add(21,'business-network','业务网络设计','diagram',grid('<div class="bt-grow">'+network('business')+'</div>',box('接口与物料口径',fields('节点上联方式','交换机互联方式','带宽与收敛比','光模块规格','线缆数量与长度','设计与配置责任'))))
    add(22,'management-network','管理网络设计','diagram',grid('<div class="bt-grow">'+network('management')+'</div>',box('管理平面边界',fields('带内 / 带外范围','管理地址与访问','设备管理口','上联及冗余方式','运维平台接入','配置与布线责任'))))
    s=svg_start()
    for x,t in [(30,'计算设备 / 管理板'),(430,'管理接入交换机'),(830,'管理汇聚交换机')]:s+=node(x,120,340,150,t+'|［端口］|［规格］','#eaf0f7')
    s+=line(370,195,430,195,arrow=True)+line(770,195,830,195,arrow=True)+label(300,80,'［介质 / 速率 / 长度 / 数量］')
    for i,t in enumerate(['物理安装','布线与端接','地址与网卡配置']):s+=node(30+i*400,400,340,135,t+'|［执行方］|［验收证据］')
    s+='</svg>'
    add(23,'port-cabling','端口布线与实施责任','diagram','<div style="flex:2;min-height:0;">'+s+'</div><div style="flex:1;min-height:0;">'+table('端点 / 端口|介质与规格|数量|端接责任|配置责任','链路一|链路二')+'</div>')
    add(24,'operations-architecture','运维方案设计与告警链路','diagram','<div class="bt-grow">'+chain(['设备与管理板','观测与告警平台','故障分析','工单与处理'])+'</div>'+grid(box('采集接口与数据',fields('性能与告警指标','协议与上报方式','账号与访问权限')),box('关键需求与闭环',fields('需求内容及编号','实现责任与版本','验证方式与结果'))))
    add(25,'room-layout','机房布局设计','diagram','<div class="bt-grow">'+floorplan()+'</div>')
    add(26,'site-survey','工勘报告与关键环境检查','evidence',grid(box('现场工勘证据',placeholder('现场照片 / 工勘报告','注明机房、时间与图纸版本')+fields('工勘责任人','报告版本')),box('环境与界面检查',table('检查项|要求|现场结果|整改责任','供配电|制冷与液冷|机柜及承重|布线通道|施工与入场|L1 / L2 移交'))))
    add(27,'security-compliance','网络安全与合规分析','statement',grid(box('交付边界',fields('方案责任主体','数据处理范围','远程接入边界')),box('安全要求',fields('客户安全要求','适用基线','未满足项')),box('第三方及闭环',fields('第三方接口','承诺与证据','负责人及计划')),cols=3)+placeholder('安全要求确认记录 / 评审证据'))
    add(28,'integration-validation','集成验证与准入证据','evidence',grid(box('验证对象与依据',fields('产品及版本组合','第三方接口','验证环境与基线','测试范围')),box('验证结果与遗留项',placeholder('集成测试报告 / 验证记录')+fields('结果与结论','遗留风险及闭环'))))
    add(29,'delivery-divider','章节·项目交付方案','transition',chain(['策略与计划','资源与供应','质量与验收']))
    add(30,'delivery-strategy','项目交付策略','sequence',lifecycle())
    add(31,'integrated-plan','分泳道集成实施计划','sequence','<div class="bt-grow">'+timeline()+'</div>'+p('关键依赖：［机房条件、物料到货、网络开通与验收基线］'))
    add(32,'resource-plan','人力资源计划','matrix',table('岗位 / 技能|来源与获取方式|阶段一投入|阶段二投入|阶段三投入|确认状态','项目管理|技术管理|硬件安装|网络与布线|软件调测|测试与验收|运维支持',compact=True))
    add(33,'procurement-strategy','采购需求与采购策略','evidence',grid(box('非转售采购需求',table('采购项|需求范围|策略与交期|成本依据','设备及物料|分包服务|租赁与现场服务')),box('书面确认证据',placeholder('采购责任人书面确认','需求方确认范围，采购方确认策略')+fields('确认人及时间','待闭环事项'))))
    add(34,'resale-procurement','第三方产品转售采购需求','matrix',fields('适用性及依据')+table('产品 / 厂商|范围与数量|采购及维保边界|交付责任|确认依据','转售产品一|转售产品二|配套服务'))
    add(35,'cooperation-cost','研发合作及其他服务成本','matrix',fields('适用性及成本归属')+table('合作事项|服务范围|成本口径|提供及确认方|交付物','研发合作|机关采购|其他服务'))
    add(36,'supply-chain','供应链管理计划','sequence',chain(['采购与备货','生产与齐套','运输与仓储','到货与签收'])+'<div style="flex:1;min-height:0;">'+table('产品或批次|计划到货|供应风险|责任人','交付批次一|交付批次二|辅料与备件')+'</div>')
    add(37,'quality-ehs','质量与EHS管理计划','matrix',grid(box('质量保证',table('控制点|管理动作|责任人','交付标准|质量检查|问题整改|质量评价')),box('EHS作业控制',table('作业风险|防护与检查|责任人','高风险作业|人员与资质|现场环境|应急处置')),box('计划与记录',placeholder('质量 / EHS 计划及检查记录')+fields('培训与检查安排','证据留存位置')),cols=3))
    add(38,'cybersecurity-plan','网络安全管理计划','matrix',table('管理项|管控措施|执行责任|检查节点|记录','账号与权限|数据与介质|远程接入|软件与配置|日志与告警|事件响应'))
    add(39,'acceptance-plan','验收管理','sequence',grid(*[box(t,fields('验收范围','标准及合同依据','验收组织与时间','签署材料')) for t in ['硬件验收','系统与性能验收','专业服务验收','维保服务验收']],cols=4))
    add(40,'revenue-plan','收入管理','matrix',source_table(40,max_rows=5))
    add(41,'inventory-plan','存货管理计划','matrix',source_table(41,max_rows=5)+p('长周期结转或异常库存应说明原因、责任人及处理计划。'))
    add(42,'partner-divider','章节·分包与伙伴能力评估','transition',chain(['承接范围','能力与资源','缺口与措施']))
    add(43,'partner-assessment','伙伴能力与交付边界','comparison',grid(*[box('伙伴 '+x+'：［名称］',fields('承接范围','能力与资质','人力与交期承诺','能力缺口','补齐措施及证据')) for x in ['一','二']]))
    add(44,'assumption-divider','章节·项目假设','transition',chain(['明确条件','确认承诺','跟踪兑现']))
    add(45,'assumption-register','项目关键假设','matrix',table('假设名称|具体条件|兑现方式|责任人|截止时间|失效影响','现场条件|工期起算|客户支撑|验收条款|方案兜底|资金与合同',compact=True))
    add(46,'risk-divider','章节·项目交付风险','transition',chain(['识别与评估','应对与责任','跟踪与闭环']))
    add(47,'risk-register','项目交付风险','matrix',table('模块|风险描述|影响与等级|应对措施|责任人|截止与状态','工期与交付|机房与协同|方案与版本|供应与采购|验收与收入',compact=True))
    add(48,'operations-divider','章节·运营运维方案','transition',chain(['服务范围','组织与责任','运行与评价']))
    add(49,'maintenance-plan','运维方案','sequence',grid(box('服务范围与责任',table('维护内容|责任主体|范围与周期','驻场服务|维保服务|平台运维|机房维护')),box('运维执行闭环',chain(['监控发现','分级响应','处理恢复'])+fields('服务级别与响应','交接与验收标准'))))
    add(50,'operations-plan','运营方案','diagram',grid('<div class="bt-grow">'+org(True)+'</div>',box('运营模式与职责',fields('运营主体与业务范围','运营目标与服务对象','岗位及资源来源','经营或服务指标','运营支撑边界','适用性及依据'))))
    add(51,'cost-divider','章节·项目服务成本测算','transition',chain(['明确成本范围','核对测算依据','确认风险准备']))
    add(52,'service-cost','项目服务成本测算','evidence',grid(box('PBA与成本测算证据',placeholder('成本模型 / PBA 测算表','保留可编辑测算附件，注明版本与币种')+fields('测算范围及版本','责任人及确认记录')),box('成本口径与关键变量',fields('自有人力与合作成本','差旅及现场费用','其他服务成本','风险准备','关键数量及单价','与范围计划的一致性'))))
    d.add('review-decisions','DRB待决策事项','matrix',9,table('待决策事项|影响与备选方案|建议与条件|决策责任|闭环证据','范围及责任界面|方案与遗留风险|关键假设|资源与成本'),None)
    d.finish();return d


def update_catalog(decks):
    path=ROOT/'scripts/editor/template-catalog.json';catalog=json.loads(path.read_text())
    for d in decks:
        t=next(x for x in catalog['templates'] if x['templateId']==d.kind)
        count=len(d.pages)+3
        t['description']=f'{"任职资格评审" if d.kind=="qualification" else "AI 算力平台 DRB 评审"}，{count} 页通用占位模板，保留表格、图形与举证页型。'
        t['requiredPages']=[dict(role=role,pageTypeId=role,name=name,sourcePage=num,position=position,**({'adaptiveToc':True} if role=='toc' else {'preserveLayout':True})) for role,name,num,position in [('cover','封面',1,'first'),('toc','目录',2,'second'),('thanks','感谢页',count,'last')]]
        t['pageTypes']=[{k:v for k,v in x.items() if k not in ['chapter','referencePage']} | {'useWhen': '用于'+x['name']+'，按页面提示填写当前材料与证据'} for x in d.pages]
        mapping={'templateId':d.kind,'pageCount':count,'pages':[{'page':1,'pageTypeId':'cover','referencePage':1},{'page':2,'pageTypeId':'toc','referencePage':2 if d.kind=='qualification' else 4}]+[{'page':x['sourcePage'],'pageTypeId':x['pageTypeId'],'name':x['name'],'visualFamily':x['visualFamily'],'referencePage':x['referencePage']} for x in d.pages]+[{'page':count,'pageTypeId':'thanks','referencePage':22 if d.kind=='qualification' else 53}]}
        (ROOT/'references'/f'{d.kind}-page-map.json').write_text(json.dumps(mapping,ensure_ascii=False,indent=2)+'\n')
    # 延续目录的紧凑格式，避免整份旧模板元数据重排。
    chunks=[]
    for t in catalog['templates']:
        scalars={k:v for k,v in t.items() if k not in ['requiredPages','pageTypes']}
        out=json.dumps(scalars,ensure_ascii=False,indent=2).rstrip()[:-1].rstrip()+',\n'
        out+='  "requiredPages": [\n'+',\n'.join('    '+json.dumps(x,ensure_ascii=False) for x in t['requiredPages'])+'\n  ],\n'
        out+='  "pageTypes": [\n'+',\n'.join('    '+json.dumps(x,ensure_ascii=False) for x in t['pageTypes'])+'\n  ]\n}'
        chunks.append('    '+out.replace('\n','\n    '))
    path.write_text('{\n  "version": 2,\n  "templates": [\n'+',\n'.join(chunks)+'\n  ]\n}\n')

if __name__=='__main__':
    decks=[qualification(),project_review()]
    update_catalog(decks)
    print('通用模板已生成：'+', '.join(f'{d.kind} {len(d.pages)+3}页' for d in decks))
