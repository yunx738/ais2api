package main

// model-policies.json (version 2, revision) — same validation and atomic save as model-policy-store.js.
import (
	"errors"
	"os"
	"regexp"
	"sort"
	"sync"
)

type Policy struct {
	Family         string
	AntiTruncation bool
}

var rePolicyID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$`)

func validatePolicies(o *Obj) (map[string]Policy, []string, error) {
	if o == nil {
		return nil, nil, errors.New("Invalid policies")
	}
	if o.Len() > 10000 {
		return nil, nil, errors.New("Too many policies")
	}
	out := map[string]Policy{}
	var order []string
	for _, id := range o.Keys() {
		p := o.Obj(id)
		if !rePolicyID.MatchString(id) || p == nil {
			return nil, nil, errors.New("Invalid model policy")
		}
		for _, k := range p.Keys() {
			if k != "quotaFamily" && k != "antiTruncation" {
				return nil, nil, errors.New("Invalid model policy")
			}
		}
		f := p.Str("quotaFamily")
		at, ok := p.V("antiTruncation").(bool)
		if !inStrs(f, "flash", "pro", "ultra") || !ok {
			return nil, nil, errors.New("Invalid model policy")
		}
		out[id] = Policy{f, at}
		order = append(order, id)
	}
	return out, order, nil
}

type PolicyStore struct {
	mu       sync.RWMutex
	file     string
	blocked  bool
	revision int64
	pol      map[string]Policy
	order    []string
}

func NewPolicyStore(file string, initial *Obj) (*PolicyStore, error) {
	s := &PolicyStore{file: file, pol: map[string]Policy{}}
	if initial != nil {
		p, o, err := validatePolicies(initial)
		if err != nil {
			return nil, err
		}
		s.pol, s.order = p, o
	}
	st, err := os.Lstat(file)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, err
	}
	if !st.Mode().IsRegular() || st.Size() > 4194304 {
		return nil, errors.New("Invalid policy file")
	}
	raw, err := readJSONFile(file)
	if err != nil {
		return nil, err
	}
	d := asObj(raw)
	rev, ok := asSafeInt(d.V("version"))
	r2, ok2 := asSafeInt(d.V("revision"))
	if d == nil || !ok || rev != 2 || !ok2 || r2 < 1 {
		return nil, errors.New("Invalid policy revision")
	}
	p, o, err := validatePolicies(d.Obj("policies"))
	if err != nil {
		return nil, err
	}
	s.pol, s.order, s.revision = p, o, r2
	return s, nil
}

func (s *PolicyStore) Get(m string) Policy {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.pol[m]
}
func (s *PolicyStore) Lookup(m string) (Policy, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.pol[m]
	return p, ok
}
func (s *PolicyStore) Order() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]string(nil), s.order...)
}
func (s *PolicyStore) Sorted() []string {
	o := s.Order()
	sort.Strings(o)
	return o
}
func (s *PolicyStore) Size() int { s.mu.RLock(); defer s.mu.RUnlock(); return len(s.pol) }

func (s *PolicyStore) policiesObj() *Obj {
	o := NewObj()
	for _, id := range s.order {
		p := s.pol[id]
		o.Set(id, NewObj().Set("quotaFamily", p.Family).Set("antiTruncation", p.AntiTruncation))
	}
	return o
}
func (s *PolicyStore) Snapshot() *Obj {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return NewObj().Set("revision", s.revision).Set("policies", s.policiesObj()).Set("blocked", s.blocked)
}

func (s *PolicyStore) Set(model, family string, at bool, revision int64) (*Obj, error) {
	s.mu.Lock()
	if s.blocked {
		s.mu.Unlock()
		return nil, errors.New("Policy storage requires reconciliation")
	}
	if revision != s.revision {
		s.mu.Unlock()
		return nil, herr(409, "Policy revision changed; refresh first")
	}
	if !rePolicyID.MatchString(model) || !inStrs(family, "flash", "pro", "ultra") {
		s.mu.Unlock()
		return nil, errors.New("Invalid model policy")
	}
	np := map[string]Policy{}
	for k, v := range s.pol {
		np[k] = v
	}
	order := append([]string(nil), s.order...)
	if _, ok := np[model]; !ok {
		order = append(order, model)
	}
	np[model] = Policy{family, at}
	old := s.pol
	oldOrder := s.order
	s.pol, s.order = np, order
	data := MarshalJS(NewObj().Set("version", 2).Set("revision", s.revision+1).Set("policies", s.policiesObj()))
	s.pol, s.order = old, oldOrder
	if err := writeAtomic(s.file, data, 0600, true); err != nil {
		s.mu.Unlock()
		return nil, errors.New("Policy save not confirmed; refresh before retry")
	}
	s.pol, s.order = np, order
	s.revision++
	s.mu.Unlock()
	return s.Snapshot(), nil
}
