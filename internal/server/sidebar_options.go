package server

import (
	"encoding/json"
	"errors"
)

type SidebarOptions struct {
	Display      string   `json:"display"`
	Sort         string   `json:"sort"`
	Order        []string `json:"order,omitempty"`
	ProjectOrder []string `json:"projectOrder,omitempty"`
}

func (s SidebarOptions) valid() bool {
	if (s.Display != "grouped" && s.Display != "merged") || (s.Sort != "updated" && s.Sort != "created" && s.Sort != "manual") || len(s.Order) > 10000 {
		return false
	}
	for _, order := range [][]string{s.Order, s.ProjectOrder} {
		if len(order) > 10000 {
			return false
		}
		seen := make(map[string]bool, len(order))
		for _, key := range order {
			if key == "" || len(key) > 8192 || seen[key] {
				return false
			}
			seen[key] = true
		}
	}
	return true
}

func (a *App) saveSidebarOptionsLocked(raw json.RawMessage) error {
	var value SidebarOptions
	if json.Unmarshal(raw, &value) != nil || !value.valid() {
		return errors.New("invalid sidebar options")
	}
	previous := a.state.SidebarOptions
	a.state.SidebarOptions = value
	if err := a.saveLocked(); err != nil {
		a.state.SidebarOptions = previous
		return err
	}
	return nil
}
