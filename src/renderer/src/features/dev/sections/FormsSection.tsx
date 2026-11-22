import { MoreHorizontal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  DropdownMenu,
  Field,
  IconButton,
  Input,
  Popover,
  RadioGroup,
  Select,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Tooltip,
  useToast,
} from '../../../ui';
import { SectionHeader } from '../../../ui/Section';
import s from './forms.module.css';

const STAGES = [
  { value: 'saved', label: 'Saved' },
  { value: 'applied', label: 'Applied' },
  { value: 'interview', label: 'Interview' },
  { value: 'archived', label: 'Archived', disabled: true },
];

function Block({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className={s.block}>
      <SectionHeader title={title} />
      <div className={s.row}>{children}</div>
    </section>
  );
}

export function FormsSection(): React.JSX.Element {
  const { toast } = useToast();
  const [dialog, setDialog] = useState<'sm' | 'md' | 'lg' | 'confirm' | 'danger' | null>(null);
  const [stage, setStage] = useState('saved');
  const [remote, setRemote] = useState(true);
  const [text, setText] = useState('Line one\nLine two');

  return (
    <div className={s.section}>
      <Block title="Input">
        <Field label="Default" hint="Shown under the field.">
          {(p) => <Input {...p} placeholder="Placeholder" />}
        </Field>
        <Field label="Small">{(p) => <Input {...p} size="sm" defaultValue="Value" />}</Field>
        <Field label="Disabled">{(p) => <Input {...p} disabled defaultValue="Locked" />}</Field>
        <Field label="Error" error="Enter a valid URL.">
          {(p) => <Input {...p} defaultValue="not a url" />}
        </Field>
      </Block>

      <Block title="Textarea">
        <Field label="Fixed">{(p) => <Textarea {...p} placeholder="Notes" />}</Field>
        <Field label="Auto-grow" hint="Type more lines.">
          {(p) => (
            <Textarea {...p} autoGrow rows={2} value={text} onChange={(e) => setText(e.target.value)} />
          )}
        </Field>
        <Field label="Disabled">{(p) => <Textarea {...p} disabled defaultValue="Locked" />}</Field>
        <Field label="Error" error="Required.">
          {(p) => <Textarea {...p} />}
        </Field>
      </Block>

      <Block title="Select">
        <Field label="Stage">
          {(p) => <Select {...p} options={STAGES} value={stage} onValueChange={setStage} />}
        </Field>
        <Field label="Small, placeholder">
          {(p) => <Select {...p} size="sm" options={STAGES} placeholder="Choose stage" />}
        </Field>
        <Field label="Disabled">{(p) => <Select {...p} disabled options={STAGES} value="saved" />}</Field>
        <Field label="Error" error="Pick a stage.">
          {(p) => <Select {...p} options={STAGES} placeholder="Choose stage" />}
        </Field>
      </Block>

      <Block title="Checkbox, Switch, Radio">
        <Checkbox label="Unchecked" />
        <Checkbox label="Checked" defaultChecked />
        <Checkbox label="Mixed" checked="indeterminate" />
        <Checkbox label="Disabled" disabled />
        <Switch label="Remote only" checked={remote} onCheckedChange={setRemote} />
        <Switch label="Disabled" disabled />
        <RadioGroup
          horizontal
          aria-label="Density"
          defaultValue="comfortable"
          options={[
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'compact', label: 'Compact' },
            { value: 'dense', label: 'Dense', disabled: true },
          ]}
        />
      </Block>

      <Block title="Tabs">
        <Tabs defaultValue="a" className={s.wide}>
          <TabsList aria-label="Example">
            <TabsTrigger value="a">Overview</TabsTrigger>
            <TabsTrigger value="b">Activity</TabsTrigger>
            <TabsTrigger value="c" disabled>
              Disabled
            </TabsTrigger>
          </TabsList>
          <TabsContent value="a">Overview content.</TabsContent>
          <TabsContent value="b">Activity content.</TabsContent>
        </Tabs>
      </Block>

      <Block title="Dialog">
        <Button onClick={() => setDialog('sm')}>Small</Button>
        <Button onClick={() => setDialog('md')}>Medium</Button>
        <Button onClick={() => setDialog('lg')}>Large</Button>
        <Button onClick={() => setDialog('confirm')}>Confirm</Button>
        <Button variant="danger" icon={<Trash2 />} onClick={() => setDialog('danger')}>
          Delete file
        </Button>
        {(['sm', 'md', 'lg'] as const).map((size) => (
          <Dialog
            key={size}
            open={dialog === size}
            onOpenChange={(o) => setDialog(o ? size : null)}
            size={size}
            title={`Dialog ${size}`}
            description="Description under the title."
            footer={
              <>
                <Button onClick={() => setDialog(null)}>Cancel</Button>
                <Button variant="primary" onClick={() => setDialog(null)}>
                  Save
                </Button>
              </>
            }
          >
            <Field label="Name">{(p) => <Input {...p} />}</Field>
          </Dialog>
        ))}
        <ConfirmDialog
          open={dialog === 'confirm'}
          onOpenChange={(o) => setDialog(o ? 'confirm' : null)}
          title="Archive 3 applications?"
          description="They move out of the active list."
          confirmLabel="Archive"
          onConfirm={() => toast({ title: 'Archived 3 applications', tone: 'ok' })}
        />
        <ConfirmDialog
          danger
          open={dialog === 'danger'}
          onOpenChange={(o) => setDialog(o ? 'danger' : null)}
          title="Delete resume-v3.pdf?"
          description="The file is removed from disk and cannot be restored."
          confirmLabel="Delete"
          onConfirm={() => toast({ title: 'Deleted resume-v3.pdf', tone: 'bad' })}
        />
      </Block>

      <Block title="Popover, Menu, Tooltip">
        <Popover trigger={<Button>Popover</Button>}>
          <Field label="Filter">{(p) => <Input {...p} size="sm" />}</Field>
        </Popover>
        <DropdownMenu
          trigger={<IconButton label="Row actions" icon={<MoreHorizontal />} />}
          items={[
            { label: 'Open', shortcut: 'Enter', onSelect: () => undefined },
            { label: 'Copy link', shortcut: 'Ctrl C', onSelect: () => undefined },
            { label: 'Unavailable', disabled: true, onSelect: () => undefined },
            'separator',
            { label: 'Delete', danger: true, onSelect: () => undefined },
          ]}
        />
        <Tooltip label="Opens the job posting">
          <Button variant="ghost">Hover or focus</Button>
        </Tooltip>
      </Block>

      <Block title="Toast">
        <Button onClick={() => toast({ title: 'Saved', tone: 'ok' })}>Ok</Button>
        <Button
          onClick={() => toast({ title: 'Source slow', description: 'Retrying in 30 s.', tone: 'warn' })}
        >
          Warn
        </Button>
        <Button
          onClick={() => toast({ title: 'Scan failed', description: 'HTTP 503 from source.', tone: 'bad' })}
        >
          Bad
        </Button>
        <Button onClick={() => toast({ title: 'Marked as applied' })}>Neutral</Button>
        <Button
          onClick={() =>
            toast({
              title: 'Application rejected',
              action: { label: 'Undo', onClick: () => toast({ title: 'Restored', tone: 'ok' }) },
            })
          }
        >
          With undo
        </Button>
      </Block>
    </div>
  );
}
