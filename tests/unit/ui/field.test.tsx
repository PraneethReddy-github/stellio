// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Field, Input } from '@renderer/ui';

afterEach(cleanup);

describe('Field', () => {
  it('labels the control and links hint and error through aria-describedby', () => {
    render(
      <Field label="Email" hint="We never send mail." error="Enter a valid address.">
        {(p) => <Input {...p} />}
      </Field>,
    );
    const input = screen.getByLabelText('Email');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const ids = (input.getAttribute('aria-describedby') ?? '').split(' ');
    expect(ids).toHaveLength(2);
    const texts = ids.map((id) => document.getElementById(id)?.textContent);
    expect(texts).toEqual(['Enter a valid address.', 'We never send mail.']);
  });

  it('omits aria attributes when there is no hint or error', () => {
    render(<Field label="Name">{(p) => <Input {...p} />}</Field>);
    const input = screen.getByLabelText('Name');
    expect(input.hasAttribute('aria-describedby')).toBe(false);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });
});
