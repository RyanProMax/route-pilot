import { Radio } from 'antd';
import type { Instance } from './data';

export function InstanceNavigation({ instances, value, onChange }: {
  instances: Instance[]; value: string | null; onChange: (value: string) => void;
}) {
  return <nav className="instance-navigation" aria-label="监控节点">
    <Radio.Group className="instance-tabs" aria-label="选择节点" name="instance"
      optionType="button" buttonStyle="solid" value={value}
      options={instances.map(instance => ({ value: instance.id, label:
        <span className="instance-label">
          {instance.country && <span className="country-code" aria-hidden="true">{instance.country}</span>}
          <span>{instance.name}</span>
        </span>,
      }))}
      onChange={event => onChange(event.target.value)} />
  </nav>;
}
