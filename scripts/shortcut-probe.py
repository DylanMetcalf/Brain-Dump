"""Print Apple's definitions (identifier, parameter keys and classes) for the Shortcuts
actions the Brain Dump Shortcut uses. Runs on a macOS CI runner."""
import glob
import plistlib

WANTED = [
    'is.workflow.actions.gettext', 'is.workflow.actions.conditional', 'is.workflow.actions.setvariable',
    'is.workflow.actions.dictatetext', 'is.workflow.actions.downloadurl', 'is.workflow.actions.getvalueforkey',
    'is.workflow.actions.repeat.each', 'is.workflow.actions.addnewreminder', 'is.workflow.actions.addnewevent',
    'is.workflow.actions.timer.start', 'is.workflow.actions.alarm.create', 'is.workflow.actions.speaktext',
    'is.workflow.actions.runworkflow', 'is.workflow.actions.documentpicker.save', 'is.workflow.actions.documentpicker.open',
    'is.workflow.actions.openurl', 'is.workflow.actions.showresult', 'is.workflow.actions.getclipboard',
    'is.workflow.actions.detect.dictionary', 'is.workflow.actions.exit', 'is.workflow.actions.notification',
    'com.apple.mobilenotes.SharingExtension', 'is.workflow.actions.date', 'is.workflow.actions.detect.date',
]

paths = glob.glob('/System/Library/PrivateFrameworks/WorkflowKit.framework/**/WFActions*.plist', recursive=True)
paths += glob.glob('/System/Library/PrivateFrameworks/*/**/WFActions*.plist', recursive=True)
print('files:', paths[:5])
seen = set()
for p in paths:
    try:
        data = plistlib.load(open(p, 'rb'))
    except Exception as e:  # noqa
        print('unreadable', p, e)
        continue
    for ident in WANTED:
        if ident in seen or ident not in data:
            continue
        seen.add(ident)
        a = data[ident]
        print('\n==', ident, '| class', a.get('ActionClass'), '| output', a.get('Output', {}).get('OutputName') if isinstance(a.get('Output'), dict) else a.get('Output'))
        for param in a.get('Parameters', []) or []:
            print('   ', param.get('Key'), '|', param.get('Class'), '| default', repr(param.get('DefaultValue'))[:60], '| items', [i if isinstance(i, str) else i.get('Value', i) for i in (param.get('Items') or [])][:8])
print('\nmissing:', [w for w in WANTED if w not in seen])
